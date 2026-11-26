/** Private project/chat sidebar, backed by the existing Steam Machine catalogue. */
export interface MedoStyle { iconText?: string; titleColor?: string; sectionColor?: string; borderColor?: string; iconColor?: string; image?: string }
export interface MedoFolder { id: string; name: string; position?: 'start' | 'end' }
export interface MedoProject { id: string; name: string; path: string; appearance?: MedoStyle; folders: MedoFolder[] }
export interface MedoChat { id: string; title: string; project: string; cwd: string; updated: number; archived: boolean; done?: boolean; unavailable: string | null; folder: string | null; paneId?: string; status?: string }
export interface MedoCatalog { drafts?: { address: string; project: string; title: string }[]; projects: MedoProject[]; chats: MedoChat[]; organizationRevision: number }
export interface MedoOpen { address: string; reused: boolean }
