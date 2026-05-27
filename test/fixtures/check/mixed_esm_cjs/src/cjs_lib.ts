// CommonJS export style — legacy module pattern still common in npm
// packages and some tool configs. Mixed with ESM in the same project.

function transformImpl(y: number): number {
    return y + 10;
}

function doThingImpl(z: number): number {
    return z - 1;
}

module.exports.transform = transformImpl;
module.exports.doThing = doThingImpl;
