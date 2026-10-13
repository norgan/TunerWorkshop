import {SETTINGS_DEFAULTS,normalizeSettings,validateSettings} from './settings-schema.mjs';

// Serializing read/merge/write keeps unrelated preferences from overwriting
// each other when a model selection and a dialog save happen together.
export function createSettingsController({read,write}){
  let current=normalizeSettings(SETTINGS_DEFAULTS),error='',queue=Promise.resolve();
  const listeners=new Set();
  const ready=Promise.resolve().then(read).then(value=>{current=normalizeSettings(value);}).catch(()=>{error='Saved settings could not be loaded. Defaults are in use; saving settings will try again.';});
  return {
    ready,
    get:()=>structuredClone(current),
    error:()=>error,
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    save(patch){
      const captured=structuredClone(patch);
      const task=queue.then(async()=>{
        await ready;
        if(!captured||typeof captured!=='object'||Array.isArray(captured))throw new Error('Invalid settings.');
        const next=validateSettings({...current,...captured});
        let stored;
        try{stored=await write(next);}catch{error='Settings could not be saved. Your previous settings are still in use. Try again.';throw new Error(error);}
        current=validateSettings(stored);error='';
        for(const listener of listeners){try{listener(structuredClone(current));}catch{ /* A display listener must not turn a completed save into a failure. */ }}
        return structuredClone(current);
      });
      queue=task.catch(()=>{});return task;
    }
  };
}
const key='tuneworkshop-settings-v1';
const desktop=globalThis.window?.workshopDesktop;
const controller=createSettingsController({
  read:()=>desktop?desktop.readSettings():globalThis.window?JSON.parse(window.localStorage.getItem(key)||'null'):SETTINGS_DEFAULTS,
  write:async value=>{if(desktop)return desktop.saveSettings(value);if(!globalThis.window)throw new Error('Storage unavailable');window.localStorage.setItem(key,JSON.stringify(value));return value;}
});
export const settingsReady=controller.ready;
export const getSettings=controller.get;
export const getSettingsError=controller.error;
export const saveSettings=patch=>controller.save(patch);
export const subscribeSettings=listener=>controller.subscribe(listener);
