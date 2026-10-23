// „ჩემი პროექტები“ (Pro): გვერდს მხოლოდ ეს ფუნქციები ეძლევა. ფაილური სისტემა main.js-შია — გვერდი გზას ვერ გადასცემს,
// მხოლოდ პროექტის id-ს; საქაღალდეს მომხმარებელი Windows-ის ფანჯარაში ირჩევს.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cqDesktop', {
  projects: {
    list: () => ipcRenderer.invoke('pj:list'),
    get: id => ipcRenderer.invoke('pj:get', id),
    put: p => ipcRenderer.invoke('pj:put', p),
    remove: id => ipcRenderer.invoke('pj:del', id),
    save: (id, pick) => ipcRenderer.invoke('pj:save', id, !!pick)
  }
});
