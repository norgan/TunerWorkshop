export function isChatSubmitKey(event,sendOnEnter){
  if(event.key!=='Enter'||event.isComposing||event.keyCode===229||event.repeat||event.altKey||event.shiftKey)return false;
  return !!(sendOnEnter||event.ctrlKey||event.metaKey);
}
