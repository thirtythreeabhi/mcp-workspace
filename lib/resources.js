'use strict';
// Host Remotion uses available machine resources and OS scheduling.
// The terminal sandbox still has independent provider-enforced limits.
function sandboxResources() { return { enforcedByProvider: true }; }
function remotionResources() { return { limits: 'host OS only' }; }
module.exports={sandboxResources,remotionResources};
