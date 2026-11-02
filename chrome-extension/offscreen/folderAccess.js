// Chrome drops folder access once no extension document holds the folder's handle. This hidden
// document holds them so that closing the side panel doesn't disconnect the project.
let heldHandles = [];

async function holdFolders() {
  const records = await moatPersistence.getAllHandles();
  heldHandles = records.map(record => record.handle);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'HOLD_FOLDERS') holdFolders();
});

holdFolders();
