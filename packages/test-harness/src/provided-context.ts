// The vitest ProvidedContext augmentation shared by the two halves of the
// setup/flow split: setup-pipeline.ts provides `e2eEnv` from vitest's main
// process, flow-hooks.ts injects it in the workers. Side-effect-imported by
// both, so any program that typechecks either half sees the augmentation.

declare module "vitest" {
  interface ProvidedContext {
    /** The setup-populated env accumulator, provided by the setup pipeline. */
    e2eEnv?: Record<string, string>;
  }
}

export {};
