import { chatInputRecipient } from "@/lib/agent/chat-input-surface";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import { runSelectionAddToChat } from "@/lib/agent/selection-quick-chat";
import { pinActiveSelection } from "@/lib/agent/selection-store";
import { toggleSidebarTabs } from "@/lib/shell/sidebar-tabs";

export function runChatShortcut(explicitSelection = false) {
	if (runSelectionAddToChat()) return;
	const recipient = chatInputRecipient();
	if (pinActiveSelection(recipient) || explicitSelection) {
		presentAgentComposer({
			preserveCaret: true,
			scopeId: recipient.scopeId,
			recipient,
		});
	} else {
		toggleSidebarTabs();
	}
}
