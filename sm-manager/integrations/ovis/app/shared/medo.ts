/** Private project/chat sidebar, backed by the existing Steam Machine catalogue. */
export interface MedoStyle { iconText?: string; titleColor?: string; sectionColor?: string; borderColor?: string; iconColor?: string; image?: string }
export interface MedoFolder { id: string; name: string; position?: 'start' | 'end' }
export interface MedoProject { id: string; name: string; path: string; appearance?: MedoStyle; folders: MedoFolder[] }
/** Server-owned state, ordered independently of catalogue response arrival and thread metadata. */
export interface MedoActivity { revision: number; completionId: string | null; unread: boolean; status: string }
export interface MedoReadReceipt { threadId: string; activity: MedoActivity }
export interface MedoChat { activity?: MedoActivity; assistant?: boolean; id: string; title: string; project: string; cwd: string; updated: number; archived: boolean; done?: boolean; unavailable: string | null; folder: string | null; paneId?: string; status?: string }
export interface MedoCatalog { drafts?: { address: string; project: string; title: string; folder?: string | null }[]; projects: MedoProject[]; chats: MedoChat[]; organizationRevision: number }
export interface MedoOpen { address: string; reused: boolean }
