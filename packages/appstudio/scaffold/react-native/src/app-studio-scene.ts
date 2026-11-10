import {NativeModules} from 'react-native';

const bridge = NativeModules.AppStudioScene as {
  load(): Promise<string>;
  save(json: string): Promise<void>;
} | undefined;

/** Publish state after the restored screen has laid out. The module exists only in debug APKs. */
export const AppStudioScene = {
  async load(): Promise<unknown> {
    return bridge ? JSON.parse(await bridge.load()) : {};
  },
  async save(state: object): Promise<void> {
    await bridge?.save(JSON.stringify(state));
  },
};
