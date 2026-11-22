/**
 * AlphaXiv folder appearance. `icon` is a Lucide name and `color` is a palette
 * name from `GET /folders/v3`. Built-in folders send both as null, so those
 * four use the same marks as the AlphaXiv sidebar.
 */

import {
	Archive,
	Atom,
	AudioLines,
	Bookmark,
	BookOpen,
	Bot,
	Brain,
	Car,
	ChartLine,
	CircleCheck,
	Code,
	Coins,
	Cpu,
	Database,
	Dna,
	Eye,
	FlaskConical,
	Folder,
	Gamepad2,
	Globe,
	GraduationCap,
	HeartPulse,
	Image,
	Inbox,
	Landmark,
	Languages,
	Layers,
	Leaf,
	Lightbulb,
	Lock,
	type LucideIcon,
	Magnet,
	MessagesSquare,
	Microscope,
	Network,
	Orbit,
	Pencil,
	Puzzle,
	Rocket,
	Scale,
	Server,
	Shield,
	Sigma,
	Sparkles,
	Star,
	Telescope,
	Workflow,
	Zap,
} from "lucide-react";

const FOLDER_ICONS: Record<string, LucideIcon> = {
	archive: Archive,
	atom: Atom,
	"audio-lines": AudioLines,
	bookmark: Bookmark,
	"book-open": BookOpen,
	bot: Bot,
	brain: Brain,
	car: Car,
	"chart-line": ChartLine,
	code: Code,
	coins: Coins,
	cpu: Cpu,
	database: Database,
	dna: Dna,
	eye: Eye,
	"flask-conical": FlaskConical,
	folder: Folder,
	"gamepad-2": Gamepad2,
	globe: Globe,
	"graduation-cap": GraduationCap,
	"heart-pulse": HeartPulse,
	image: Image,
	inbox: Inbox,
	landmark: Landmark,
	languages: Languages,
	layers: Layers,
	leaf: Leaf,
	lightbulb: Lightbulb,
	lock: Lock,
	magnet: Magnet,
	"messages-square": MessagesSquare,
	microscope: Microscope,
	network: Network,
	orbit: Orbit,
	puzzle: Puzzle,
	rocket: Rocket,
	scale: Scale,
	server: Server,
	shield: Shield,
	sigma: Sigma,
	sparkles: Sparkles,
	star: Star,
	telescope: Telescope,
	workflow: Workflow,
	zap: Zap,
};

/** Built-in AlphaXiv folders send `icon: null`. These match the site sidebar. */
const BUILTIN_FOLDER_ICONS: Record<string, LucideIcon> = {
	"default-publications": Pencil,
	"default-to-read": Bookmark,
	"default-reading": BookOpen,
	"default-completed": CircleCheck,
};

/** AlphaXiv's folder palette. `red` follows their light and dark brand red. */
const FOLDER_COLORS: Record<string, string> = {
	red: "text-[oklch(45.36%_0.1566_16.66)] dark:text-[oklch(83.7%_0.0898_24.2)]",
	orange: "text-[#fe6e00]",
	amber: "text-[#e2a100]",
	green: "text-[#00c758]",
	teal: "text-[#2aa897]",
	blue: "text-[#4a90e2]",
	purple: "text-[#ac4bff]",
	pink: "text-[#f6339a]",
	gray: "text-muted-foreground",
};

export function AlphaXivFolderIcon({
	icon,
	color,
	folderType,
}: {
	icon?: string;
	color?: string;
	folderType?: string;
}) {
	const iconName = (icon ?? "").trim().toLowerCase();
	const named = iconName in FOLDER_ICONS ? FOLDER_ICONS[iconName] : undefined;
	const typeName = (folderType ?? "").trim();
	const Icon =
		named ??
		(typeName in BUILTIN_FOLDER_ICONS
			? BUILTIN_FOLDER_ICONS[typeName]
			: undefined);
	if (!Icon) return null;
	const paint = named
		? (FOLDER_COLORS[(color ?? "").trim().toLowerCase()] ??
			"text-muted-foreground")
		: "text-muted-foreground";
	return <Icon className={`size-3.5 shrink-0 ${paint}`} aria-hidden />;
}
