/** Browser metadata transport fixture; real Stagehand and provider operations use their own fixtures. */

/** Metadata transport with no installed Stagehand runtime. */
export const chromium = {
  async connectOverCDP() {
    return {
      async newBrowserCDPSession() { return { async send() { return { extensions: [] } } } },
      async close() {},
    }
  },
}
