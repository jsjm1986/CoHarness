/**
 * Message-source declaration for the demo-session fixture producer in
 * `client/fixture.ts`. The persistence schema catalog reads host-face sources,
 * so this ambient merge lives on the shared face both programs compile.
 */

export {}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Demo-session fixture producer kind; exists only inside this generator.
     * @persistenceAttribution
     */
    fixture: { kind: 'fixture' }
  }
}
