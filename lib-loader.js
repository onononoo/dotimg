// loads a vendored library the first time it is needed, and only once.
//
// every family beyond media leans on a third-party library, several of them large, so
// nothing is fetched until a file of that kind actually arrives. a visitor compressing a
// photo never downloads a css minifier.

const modules = new Map();
const scripts = new Map();

/** import an es module from vendor/, cached so repeat calls share one load. */
export function loadModule(path) {
  if (!modules.has(path)) {
    const url = new URL(path, import.meta.url).href;
    modules.set(path, import(url).catch((err) => {
      modules.delete(path); // let a later attempt retry rather than cache the failure
      throw new Error('could not load a part of dotimg (' + path + '): ' + (err.message || err));
    }));
  }
  return modules.get(path);
}

/**
 * load an old-style script that attaches itself to the page as a global, for the few
 * libraries that ship no es module build, and resolve with that global.
 */
export function loadScript(path, globalName) {
  if (!scripts.has(path)) {
    scripts.set(path, new Promise((resolve, reject) => {
      if (globalThis[globalName]) return resolve(globalThis[globalName]);
      const tag = document.createElement('script');
      tag.src = new URL(path, import.meta.url).href;
      tag.onload = () => globalThis[globalName]
        ? resolve(globalThis[globalName])
        : reject(new Error(path + ' loaded but did not provide ' + globalName));
      tag.onerror = () => {
        scripts.delete(path);
        reject(new Error('could not load a part of dotimg (' + path + ')'));
      };
      document.head.append(tag);
    }));
  }
  return scripts.get(path);
}
