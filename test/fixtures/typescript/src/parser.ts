export function parseProfile(profile: { id: number; name?: string }): string {
  return profile.name!.trim();
}
export function unusedFormatter(value: string): string { return value.toUpperCase(); }
export const unusedConfiguration = { enabled: true, label: 'irrelevant' };
export class UnusedService { ping(): string { return 'pong'; } }
