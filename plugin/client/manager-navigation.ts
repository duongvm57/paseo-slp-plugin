import type { PluginScreenParams } from "@getpaseo/plugin/client";

export const MANAGER_SCREEN_ID = "manager";
export const MANAGER_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "profiles", label: "Profiles" },
  { id: "pool", label: "Peer pool" },
  { id: "jev", label: "Routing / Jev" },
  { id: "supervision", label: "Supervision" },
  { id: "language", label: "Language" },
  { id: "maintenance", label: "Maintenance" },
] as const;
export type ManagerSectionId = (typeof MANAGER_SECTIONS)[number]["id"];

export function managerSection(params: PluginScreenParams): ManagerSectionId {
  return MANAGER_SECTIONS.find(section => section.id === params.section)?.id ?? "overview";
}

/** Only closed section identifiers enter the host URL. */
export const managerLocation = (section: ManagerSectionId = "overview") => ({
  screenId: MANAGER_SCREEN_ID, params: { section },
});
export const managerTitle = (params: PluginScreenParams): string =>
  `SLP · ${MANAGER_SECTIONS.find(section => section.id === managerSection(params))!.label}`;
