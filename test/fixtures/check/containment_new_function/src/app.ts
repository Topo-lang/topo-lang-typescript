// `makeHandler` is not external; `new Function()` is a containment escape.

export function makeHandler(seed: number): number {
    const fn = new Function("return " + seed);
    return fn();
}
