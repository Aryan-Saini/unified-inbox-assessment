"use client";

import {
  ConnectorSwitchboard,
  type SwitchboardProps,
} from "./ConnectorSwitchboard";
import { Modal } from "./ui";

/**
 * The full-screen route to the same switchboard the search bar's dropdown
 * shows. Kept because the results status strip routes a broken source here,
 * where there is room for the whole picture rather than a popover.
 */
export function ConnectionsDialog({
  open,
  onClose,
  ...switchboard
}: SwitchboardProps & { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connections"
      subtitle="Turn a connector on or off, add accounts, and choose which accounts a search fans out to."
      width="max-w-3xl"
    >
      <ConnectorSwitchboard {...switchboard} />
    </Modal>
  );
}
