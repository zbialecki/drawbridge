// React and Next.js context for an annotation.
//
// inspectPageContext runs in the page's MAIN world through chrome.scripting, because the
// content script's isolated world cannot see React fibers or page globals. It must stay
// self-contained, and everything it returns is page-controlled: background.js passes the
// result through sanitizeFrameworkContext before it reaches the annotation.

async function inspectPageContext(marker) {
  const NETWORK_TIMEOUT_MS = 1000;
  const MAX_DEPTH = 64;
  const MAX_SOURCE_CANDIDATES = 4;
  // Next.js wrappers that say nothing about where the app's own code lives.
  const FRAMEWORK_COMPONENTS = new Set([
    'AppDevOverlayErrorBoundary', 'AppRouter', 'AppRouterAnnouncer', 'ClientPageRoot', 'ClientSegmentRoot',
    'DevRootHTTPAccessFallbackBoundary', 'ErrorBoundaryHandler', 'GlobalLayoutRouterContext', 'HTTPAccessErrorFallback',
    'HTTPAccessFallbackBoundary', 'HTTPAccessFallbackErrorBoundary', 'HandleISRError', 'HistoryUpdater',
    'HotReload', 'ImageElement', 'InnerLayoutRouter', 'InnerScrollHandler', 'InnerScrollAndFocusHandler', 'LayoutRouter',
    'LayoutRouterContext', 'LinkComponent', 'LoadingBoundary', 'MetadataBoundary', 'MetadataTree', 'NotFoundBoundary',
    'OuterLayoutRouter', 'OutletBoundary', 'PathParamsContext', 'PathnameContextProviderAdapter', 'RedirectBoundary',
    'RedirectErrorBoundary', 'RenderFromTemplateContext', 'ReplaySsrOnlyErrors', 'Root', 'RootErrorBoundary',
    'Router', 'RuntimeStyles', 'ScrollAndFocusHandler', 'ScrollHandler', 'SearchParamsContext',
    'SegmentStateProvider', 'SegmentViewNode', 'SegmentViewStateNode', 'SegmentBoundaryTriggerNode',
    'ServerRoot', 'TemplateContext', 'ViewportBoundary', 'ViewportTree'
  ]);
  const INTERNAL_FRAME = /(?:^|\.)(?:jsxDEV|jsx|jsxs|createElement|react_stack_bottom_frame)$/;
  const INTERNAL_FILE = /react-dom|react-server|next_dist|next\/dist|node_modules/;

  const element = marker ? document.querySelector(`[data-drawbridge-inspect="${marker}"]`) : null;
  element?.removeAttribute('data-drawbridge-inspect');

  const timedFetch = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });

  // Next empties window.__next_f after hydration, but its inline scripts stay in the document.
  function readFlightBuildId() {
    for (const script of document.scripts) {
      const text = script.textContent;
      if (!text.includes('__next_f') || !text.includes('0:{')) continue;
      const match = /\\"b\\":\\"([^\\"]+)\\"\}\\n/.exec(text) ?? /\\"b\\":\\"([^\\"]+)\\"/.exec(text);
      if (match) return match[1];
    }
    return null;
  }

  function readNextFramework() {
    const nextData = window.__NEXT_DATA__;
    if (!window.next && !nextData && !window.__next_f) return null;
    const buildId = nextData?.buildId ?? readFlightBuildId();
    const chunk = [...document.scripts].find(script => /[?&]dpl=/.test(script.src));
    return {
      name: 'next',
      version: window.next?.version ?? null,
      router: nextData ? 'pages' : 'app',
      mode: buildId === 'development' || document.querySelector('nextjs-portal') ? 'development' : 'production',
      buildId,
      deploymentId: document.documentElement.getAttribute('data-dpl-id')
        ?? (chunk ? new URL(chunk.src).searchParams.get('dpl') : null)
    };
  }

  async function callNextMcp(name) {
    const response = await timedFetch('/_next/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
    });
    if (!response.ok) throw new Error(`MCP ${response.status}`);
    const payload = /^data: (.*)$/m.exec(await response.text())?.[1];
    return JSON.parse(JSON.parse(payload).result.content[0].text);
  }

  const readFiber = node => {
    const key = node && Object.keys(node).find(name => name.startsWith('__reactFiber$'));
    return key ? node[key] : null;
  };

  function componentName(entry) {
    if (typeof entry.name === 'string') return entry.name;
    const type = entry.type;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (type && typeof type === 'object') {
      return type.displayName || type.render?.displayName || type.render?.name || type.type?.displayName || type.type?.name || null;
    }
    return null;
  }

  const isAppComponent = name => !!name && !FRAMEWORK_COMPONENTS.has(name) && !name.startsWith('__next');

  function readOwners(fiber) {
    const owners = [];
    let owner = fiber._debugOwner;
    for (let depth = 0; owner && depth < MAX_DEPTH; depth++) {
      owners.push(owner);
      owner = owner._debugOwner ?? owner.owner;
    }
    return owners;
  }

  // Walk rendered ancestors for server components and Next's segment files.
  function readAncestors(fiber) {
    const serverComponents = [];
    const segments = [];
    let current = fiber;
    for (let depth = 0; current && depth < 2000; depth++) {
      for (const info of Array.isArray(current._debugInfo) ? current._debugInfo : []) {
        if (info?.name && info.env) serverComponents.push(info);
      }
      const props = current.memoizedProps;
      if (componentName(current) === 'SegmentViewNode' && props?.pagePath) {
        segments.push({ type: props.type, path: props.pagePath });
      }
      current = current.return;
    }
    return { serverComponents, segments };
  }

  // Client fibers carry an Error stack; server entries carry parsed [name, file, line, column] frames.
  function readAppFrame(candidate) {
    const frames = Array.isArray(candidate.stack)
      ? candidate.stack.map(([methodName, file, line, column]) => ({ methodName, file, line, column }))
      : String(candidate._debugStack?.stack || '').split('\n').map(text => {
        const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(text);
        return match && { methodName: match[1], file: match[2], line: match[3], column: match[4] };
      });
    for (const frame of frames) {
      if (!frame?.file || !Number(frame.line)) continue;
      const methodName = frame.methodName || '<unknown>';
      if (INTERNAL_FRAME.test(methodName) || INTERNAL_FILE.test(frame.file)) continue;
      return {
        methodName,
        file: frame.file.startsWith('/') ? `file://${frame.file}` : frame.file,
        line1: Number(frame.line),
        column1: Number(frame.column),
        arguments: [],
        isServer: Array.isArray(candidate.stack) || frame.file.startsWith('about://React/Server/')
      };
    }
    return null;
  }

  function serverDistDir(serverComponents) {
    for (const info of serverComponents) {
      for (const frame of Array.isArray(info.stack) ? info.stack : []) {
        const match = /^(?:file:\/\/)?(\/.*?)\/server\/(?:chunks|app|pages)\//.exec(decodeURIComponent(String(frame?.[1] || '')));
        if (match) return match[1];
      }
    }
    return null;
  }

  // Next's client resolves chunk URLs to files in its dist folder before tracing them.
  function toTraceRequest({ isServer, ...frame }, distDir) {
    let file = frame.file;
    if (/^https?:/.test(file)) {
      const url = new URL(file);
      const staticPath = /\/_next(\/static\/.+)$/.exec(url.pathname)?.[1];
      if (staticPath && distDir) file = `file://${distDir}${staticPath}${url.search}`;
      else file = url.pathname + url.search;
    }
    return { frame: { ...frame, file }, isServer };
  }

  function projectRelative(file, projectPath) {
    let path = String(file || '').replace(/^file:\/\//, '').replace(/^\[project\]\//, '').replace(/^\.\//, '');
    if (projectPath && path.startsWith(`${projectPath}/`)) path = path.slice(projectPath.length + 1);
    return path && !path.startsWith('/') && !INTERNAL_FILE.test(path) && !path.includes('_next/') ? path : null;
  }

  async function traceFrame(frame, distDir, projectPath) {
    const { frame: traced, isServer } = toTraceRequest(frame, distDir);
    const response = await timedFetch('/__nextjs_original-stack-frames', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames: [traced], isServer, isEdgeServer: false, isAppDirectory: true })
    });
    if (!response.ok) return null;
    const original = (await response.json())?.[0]?.value?.originalStackFrame;
    const path = !original || original.ignored ? null : projectRelative(original.file, projectPath);
    return path && original.line1 ? `${path}:${original.line1}:${original.column1 ?? 1}` : null;
  }

  async function resolveSource(candidates, serverComponents, project) {
    const distDir = serverDistDir(serverComponents) ?? (project?.projectPath ? `${project.projectPath}/.next/dev` : null);
    let attempts = 0;
    for (const candidate of candidates) {
      const frame = readAppFrame(candidate);
      if (!frame) continue;
      if (++attempts > MAX_SOURCE_CANDIDATES) return null;
      const source = await traceFrame(frame, distDir, project?.projectPath).catch(() => null);
      if (source) return source;
    }
    return null;
  }

  function readRoute(metadata, segments) {
    const sessions = Array.isArray(metadata?.sessions) ? metadata.sessions : [];
    const session = sessions.find(entry => String(entry.url).split('?')[0] === location.pathname);
    // Fiber segments run innermost first; MCP segments already run outermost first.
    const entries = session?.segments?.filter(segment => !segment.isBuiltin) ?? [...segments].reverse();
    return {
      route: entries.find(segment => segment.type === 'page')?.path ?? null,
      layouts: entries.filter(segment => segment.type === 'layout').map(segment => segment.path)
    };
  }

  function readComponents(owners, serverComponents, router) {
    const chain = owners
      .map(owner => ({ name: componentName(owner), env: owner.env ? 'server' : 'client' }))
      .filter(entry => isAppComponent(entry.name));
    // The default Pages Router wrapper is not part of the app's own code.
    if (router === 'pages' && chain.at(-1)?.name === 'App') chain.pop();
    if (!chain.length) return null;
    const firstServer = chain.findIndex(entry => entry.env === 'server');
    const lastClient = firstServer === -1 ? chain.length - 1 : firstServer - 1;
    const servers = [...chain.filter(entry => entry.env === 'server').map(entry => entry.name),
      ...serverComponents.map(info => info.name).filter(isAppComponent)];
    return {
      component: chain[0].name,
      componentEnv: chain[0].env,
      owners: chain.slice(1).map(entry => entry.name),
      serverComponents: [...new Set(servers)],
      clientBoundary: router !== 'pages' && lastClient >= 0 ? {
        component: chain[lastClient].name,
        renderedBy: firstServer === -1 ? null : chain[firstServer].name
      } : null
    };
  }

  const framework = readNextFramework();
  // Production builds minify component names, so only build identity is worth keeping.
  if (framework?.mode === 'production') return { framework };

  const fiber = readFiber(element);
  const hasDebugData = !!fiber && '_debugOwner' in fiber;
  const owners = hasDebugData ? readOwners(fiber) : [];
  const { serverComponents, segments } = hasDebugData ? readAncestors(fiber) : { serverComponents: [], segments: [] };
  const components = hasDebugData ? readComponents(owners, serverComponents, framework?.router) : null;
  if (!framework) return components ? { react: components } : {};

  const [metadata, project] = await Promise.all([
    callNextMcp('get_page_metadata').catch(() => null),
    callNextMcp('get_project_metadata').catch(() => null)
  ]);
  const source = hasDebugData
    ? await resolveSource([fiber, ...owners], serverComponents, project).catch(() => null)
    : null;
  return {
    framework: { ...framework, mcpAvailable: !!(metadata || project) },
    react: { ...components, source, ...readRoute(metadata, segments) }
  };
}

function sanitizeFrameworkContext(raw, pageUrl) {
  const text = (value, max = 120) => (typeof value === 'string' && value
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
    : null);
  const names = value => (Array.isArray(value) ? value.map(item => text(item)).filter(Boolean).slice(0, 24) : []);
  const relativePath = value => {
    const path = text(value, 300);
    return path && /^[^/\\:*?"<>|][^\\:*?"<>|]*$/.test(path) && !path.split('/').includes('..') ? path : null;
  };
  const source = value => {
    const match = /^(.*):(\d+):(\d+)$/.exec(text(value, 320) || '');
    return match && relativePath(match[1]) ? match[0] : null;
  };

  const context = {};
  if (raw?.framework?.name === 'next') {
    const { version, router, mode, buildId, deploymentId, mcpAvailable } = raw.framework;
    context.framework = {
      name: 'next',
      version: text(version, 40),
      router: router === 'pages' ? 'pages' : 'app',
      mode: mode === 'development' ? 'development' : 'production',
      buildId: text(buildId, 200),
      deploymentId: text(deploymentId, 200)
    };
    // Built from the tab's URL, not page data, and local-only so a page cannot point an agent elsewhere.
    const url = new URL(pageUrl);
    if (mcpAvailable === true && mode === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      context.framework.mcpEndpoint = `${url.origin}/_next/mcp`;
    }
  }

  const react = raw?.react;
  if (react && context.framework?.mode !== 'production') {
    const cleaned = {
      component: text(react.component),
      componentEnv: react.componentEnv === 'server' ? 'server' : react.componentEnv === 'client' ? 'client' : null,
      owners: names(react.owners),
      source: source(react.source),
      serverComponents: names(react.serverComponents),
      clientBoundary: text(react.clientBoundary?.component) ? {
        component: text(react.clientBoundary.component),
        renderedBy: text(react.clientBoundary.renderedBy)
      } : null,
      route: relativePath(react.route),
      layouts: (Array.isArray(react.layouts) ? react.layouts : []).map(relativePath).filter(Boolean).slice(0, 24)
    };
    if (cleaned.component || cleaned.source || cleaned.route) context.react = cleaned;
  }
  return context;
}

const DrawbridgeFrameworkContext = { inspectPageContext, sanitizeFrameworkContext };
if (typeof module !== 'undefined' && module.exports) module.exports = DrawbridgeFrameworkContext;
globalThis.DrawbridgeFrameworkContext = DrawbridgeFrameworkContext;
