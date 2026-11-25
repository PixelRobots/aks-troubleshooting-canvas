import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import declaration from './extension.json' with { type: 'json' };
import { createInstance } from './server.mjs';

const instances = new Map();
const handlers = {
  get_context: async ({ instanceId }) => {
    const instance = instances.get(instanceId);
    if (!instance) throw new CanvasError('NOT_FOUND', 'Open the canvas first.');
    return instance.getContext();
  },
  add_finding: async ({ instanceId, input }) => {
    const instance = instances.get(instanceId);
    if (!instance) throw new CanvasError('NOT_FOUND', 'Open the canvas first.');
    try {
      return instance.addFinding(input.text);
    } catch (error) {
      throw new CanvasError('INVALID_INPUT', error.message);
    }
  }
};

await joinSession({
  canvases: declaration.canvases.map(canvas => createCanvas({
    ...canvas,
    actions: canvas.actions.map(action => ({ ...action, handler: handlers[action.name] })),
    open: async ({ instanceId }) => {
      if (!instances.has(instanceId)) {
        try {
          instances.set(instanceId, await createInstance());
        } catch (error) {
          throw new CanvasError('UNAVAILABLE', `Unable to open the canvas: ${error.message}`);
        }
      }
      return { url: instances.get(instanceId).url };
    },
    onClose: async ({ instanceId }) => {
      const instance = instances.get(instanceId);
      if (instance) {
        await instance.close();
        instances.delete(instanceId);
      }
    }
  }))
});
