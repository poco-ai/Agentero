import { createPortal } from "react-dom";
import {
	useVoiceDefense,
	type VoiceDefenseDialogProps,
} from "@/components/agent/use-voice-defense";
import { EndedAct } from "@/components/agent/voice-defense/ended-act";
import { LiveAct } from "@/components/agent/voice-defense/live-act";
import { SetupAct } from "@/components/agent/voice-defense/setup-act";

export type { VoiceDefenseDialogProps } from "@/components/agent/use-voice-defense";

export function VoiceDefenseDialog(props: VoiceDefenseDialogProps) {
	const viva = useVoiceDefense(props);
	if (!viva.open) return null;

	const shell = (
		<div
			className={
				viva.windowMode
					? "h-full w-full bg-background"
					: "fade-in-0 fixed inset-0 z-50 animate-in bg-background duration-300"
			}
			role="dialog"
			aria-modal={viva.windowMode ? undefined : true}
			aria-label={viva.t("voiceDefense.title")}
		>
			{viva.phase === "prepare" ? (
				<SetupAct
					title={viva.displayTitle}
					authStatus={viva.authStatus}
					authBusy={viva.authBusy}
					onConnectAccount={() => void viva.connectAccount()}
					onCancelAccountConnection={() => void viva.cancelAccountConnection()}
					onDisconnectAccount={() => void viva.disconnectAccount()}
					materials={viva.selectedMaterials}
					materialOptions={viva.filteredMaterialOptions}
					currentMaterialPath={viva.focusedMaterialPath}
					selectedMaterialPaths={viva.selectedMaterialPaths}
					materialSearch={viva.materialSearch}
					onMaterialSearchChange={viva.setMaterialSearch}
					onToggleMaterial={viva.toggleMaterial}
					inputsLocked={viva.preparationInputsLocked}
					instruction={viva.instruction}
					onInstructionChange={viva.setInstruction}
					plannedMinutes={viva.plannedMinutes}
					onPlannedMinutesChange={viva.selectPlannedMinutes}
					scenario={viva.scenario}
					onScenarioChange={viva.selectScenario}
					defenseLanguage={viva.defenseLanguage}
					onDefenseLanguageChange={viva.selectDefenseLanguage}
					difficulty={viva.difficulty}
					onDifficultyChange={viva.selectDifficulty}
					reusable={
						viva.reusableManifest
							? {
									updatedAt: viva.reusableManifest.updatedAt,
									partial: viva.reusableManifest.partial,
								}
							: null
					}
					onUseReusable={viva.useReusablePreparation}
					history={viva.history}
					onOpenHistory={(path) => viva.onOpenSource?.(path)}
					preparation={viva.preparation}
					preparationActive={viva.preparationActive}
					preparationLoading={viva.preparationLoading}
					preparationStatusLabel={viva.preparationStatusLabel}
					preparationReady={viva.preparationReady}
					preparationFailed={viva.preparationFailed}
					preparationStale={Boolean(viva.preparation?.stale)}
					selectionChanged={viva.selectionChanged}
					voiceStarting={viva.voiceStarting}
					startError={viva.startError}
					brief={viva.context}
					onBriefChange={viva.setContext}
					briefSource={viva.source}
					onPrepare={() => void viva.runPreparation(false)}
					onRetry={() => void viva.runPreparation(Boolean(viva.preparation))}
					onCancelPreparation={() => void viva.cancelPreparation()}
					onStart={() => void viva.startWithPreparedMaterial()}
				/>
			) : viva.phase === "ended" ? (
				<EndedAct
					windowMode={viva.windowMode}
					title={viva.defenseTitle}
					durationSeconds={viva.durationSeconds}
					questionCount={viva.questionCount}
					captions={viva.captions}
					debrief={viva.debrief}
					review={viva.review}
					reviewPath={viva.reviewPath}
					reviewing={viva.reviewing}
					savedPath={viva.savedPath}
					saving={viva.savingTranscript}
					canRestart={Boolean(viva.context.trim()) && !viva.voiceStarting}
					onSaveTranscript={
						viva.vaultPath && viva.captions.length > 0 && !viva.savedPath
							? () => void viva.saveTranscript()
							: null
					}
					onOpenTranscript={
						viva.savedPath && viva.onOpenSource
							? () => {
									if (viva.savedPath) viva.onOpenSource?.(viva.savedPath);
								}
							: null
					}
					onEvaluate={
						viva.vaultPath && viva.captions.length > 0 && !viva.reviewPath
							? () => void viva.generateReview()
							: null
					}
					onOpenReview={
						viva.reviewPath && viva.onOpenSource
							? () => {
									if (viva.reviewPath) viva.onOpenSource?.(viva.reviewPath);
								}
							: null
					}
					onRestart={() => void viva.restartDefense()}
					onClose={() => viva.handleOpenChange(false)}
				/>
			) : (
				<LiveAct
					phase={viva.phase}
					connectionStatus={viva.connectionStatus}
					captions={viva.captions}
					stageCaptions={viva.stageCaptions}
					muted={viva.muted}
					errorText={viva.errorText}
					title={viva.defenseTitle}
					startedAt={viva.startedAt}
					plannedDurationSeconds={
						viva.plannedMinutes !== null ? viva.plannedMinutes * 60 : null
					}
					onTimeUp={viva.handleTimeUp}
					onToggleMuted={viva.toggleMuted}
					onInterrupt={viva.interrupt}
					onSendPatch={viva.sendLivePatch}
					onRefocus={viva.sendLiveRefocus}
					onEnd={() => void viva.endSession()}
					onCancelConnecting={() => viva.handleOpenChange(false)}
					onRetry={viva.retryPrepare}
					onClose={() => viva.handleOpenChange(false)}
				/>
			)}
			<audio ref={viva.audioRef} autoPlay muted className="sr-only">
				<track kind="captions" src="data:text/vtt,WEBVTT%0A" />
			</audio>
		</div>
	);
	return viva.windowMode ? shell : createPortal(shell, document.body);
}
