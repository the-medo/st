/** Private project/chat sidebar, backed by the existing Steam Machine catalogue. */
export interface MedoStyle { iconText?: string; titleColor?: string; sectionColor?: string; borderColor?: string; iconColor?: string; image?: string }
export interface MedoFolder { id: string; name: string; position?: 'start' | 'end' }
export interface MedoProject { id: string; name: string; path: string; appearance?: MedoStyle; folders: MedoFolder[] }
export type MedoProvider = 'codex' | 'claude';
/** Server-owned state, ordered independently of catalogue response arrival and thread metadata. */
export interface MedoActivity { revision: number; completionId: string | null; unread: boolean; status: string }
export interface MedoReadReceipt { threadId: string; activity: MedoActivity }
export interface MedoChat { activity?: MedoActivity; assistant?: boolean; id: string; provider?: MedoProvider; title: string; project: string; cwd: string; updated: number; archived: boolean; done?: boolean; unavailable: string | null; folder: string | null; paneId?: string; status?: string }
export interface MedoCatalog { drafts?: { address: string; project: string; title: string; folder?: string | null }[]; projects: MedoProject[]; chats: MedoChat[]; organizationRevision: number }
export interface MedoOpen { address: string; reused: boolean; first_message?: { id: string; held?: string } | { error: { message: string } } }
export interface MedoModel { id: string; label: string; efforts: string[]; defaultEffort: string; isDefault?: boolean }
export interface MedoProviderOption { id: MedoProvider; label: string; installed: boolean; models: MedoModel[]; error: string | null; usageKey: string | null }
/** GET /api/medo/providers: CLI choices and the account key used by /api/usage, never credentials. */
export interface MedoProviders { providers: MedoProviderOption[] }
/** POST /api/medo/new: the selected CLI and its first message, queued once through this page's connection. */
export interface MedoNewRequest { projectId?: string; folderId?: string; cwd?: string; provider: MedoProvider; model: string; effort: string; prompt?: string; first_message_connection?: string }
