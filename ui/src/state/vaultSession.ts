export interface VaultSession {
  root: string;
  generation: string;
  vault_id?: string | null;
}

type Activation = { session?: VaultSession | null } | null;
let activeVault: () => Activation = () => null;

/** Installed by the vault store without making the IPC layer import the UI store graph. */
export function bindVaultSession(read: () => Activation) {
  activeVault = read;
}

/** Capture the activation object, not just its root: reopening A is a new lifetime. */
export function vaultOperation(): () => boolean {
  const vault = activeVault();
  return () => activeVault() === vault;
}

/** Native events always carry a session. Legacy browser fixtures without a session stay usable. */
export function isCurrentSession(session?: VaultSession): boolean {
  const active = activeVault()?.session;
  return active
    ? !!session &&
        active.root === session.root &&
        active.generation === session.generation &&
        active.vault_id === session.vault_id
    : !session;
}
