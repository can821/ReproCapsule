export function parseProfile(profile: { id: number; name?: string }): string {
  return profile.name!.trim();
}
