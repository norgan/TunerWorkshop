// Small transport-neutral event interface shared by Node serial/TCP and Web BLE.
export class Emitter {
  #events=new Map();
  on(name,listener){const list=this.#events.get(name)||[];list.push(listener);this.#events.set(name,list);return this;}
  off(name,listener){const list=this.#events.get(name)||[];this.#events.set(name,list.filter(item=>item!==listener&&item.listener!==listener));return this;}
  once(name,listener){const wrapped=(...args)=>{this.off(name,wrapped);listener(...args);};wrapped.listener=listener;return this.on(name,wrapped);}
  emit(name,...args){const list=[...(this.#events.get(name)||[])];for(const listener of list)listener(...args);return list.length>0;}
}
