declare module "@slack/bolt" {
  // Minimal stub for the parts of Bolt used in this codebase.
  // Extend as needed when additional members are referenced.
  export class App {
    constructor(...args: any[]);

    // Event registration helpers
    message(...args: any[]): any;
    event(eventName: string, ...args: any[]): any;
    action(actionId: string, ...args: any[]): any;

    // Web client
    client: any;

    // Start the bolt app (used in index.ts)
    start(...args: any[]): Promise<void>;
  }
}
