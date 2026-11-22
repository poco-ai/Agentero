import { LayoutGrid, LibraryBig, Search, Table2 } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { libraryBreadcrumbs } from "@/components/library/library-folders";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/core/utils";

export type LibraryViewMode = "table" | "cards";

const crumbClass =
	"inline-flex h-7 items-center gap-1.5 border border-transparent px-1.5 text-sm font-medium text-foreground";

const viewModes = [
	{ mode: "table", icon: Table2, label: "papersLibrary.tableView" },
	{ mode: "cards", icon: LayoutGrid, label: "papersLibrary.cardView" },
] as const;

export function LibraryViewToolbar({
	mode,
	onModeChange,
	scopePath,
	onNavigateFolder,
	query,
	onSearch,
	children,
}: {
	mode: LibraryViewMode;
	onModeChange: (mode: LibraryViewMode) => void;
	scopePath: string | null;
	onNavigateFolder?: (path: string | null) => void;
	query: string;
	onSearch?: (query: string) => void;
	children?: ReactNode;
}) {
	const { t } = useTranslation("sidebar");
	const crumbs = [
		{ name: t("papersLibrary.title"), path: null },
		...libraryBreadcrumbs(scopePath),
	];
	return (
		<div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-border/50 border-b px-3 py-1.5">
			<Breadcrumb
				aria-label={t("papersLibrary.folderPath")}
				className="min-w-0 flex-1 basis-36 overflow-x-auto [scrollbar-width:none]"
			>
				<BreadcrumbList className="w-max flex-nowrap gap-1">
					{crumbs.map(({ name, path }, index) => (
						<Fragment key={path ?? "root"}>
							{index > 0 ? <BreadcrumbSeparator className="shrink-0" /> : null}
							<BreadcrumbItem>
								{index === crumbs.length - 1 ? (
									<BreadcrumbPage className={crumbClass}>
										{index === 0 ? (
											<LibraryBig className="size-3.5" aria-hidden />
										) : null}
										<span className="max-w-44 truncate" title={name}>
											{name}
										</span>
									</BreadcrumbPage>
								) : (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className={crumbClass}
										title={name}
										onClick={() => onNavigateFolder?.(path)}
									>
										{index === 0 ? (
											<LibraryBig className="size-3.5" aria-hidden />
										) : null}
										<span className="max-w-44 truncate">{name}</span>
									</Button>
								)}
							</BreadcrumbItem>
						</Fragment>
					))}
				</BreadcrumbList>
			</Breadcrumb>
			<div className="ml-auto flex min-w-0 items-center gap-1.5">
				{mode === "cards" && onSearch ? (
					<div className="relative min-w-0 w-48">
						<Search
							className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
							aria-hidden
						/>
						<Input
							type="search"
							className="h-7 bg-muted/60 pl-7 text-xs"
							aria-label={t("papersLibrary.search")}
							value={query}
							onChange={(event) => onSearch(event.target.value)}
						/>
					</div>
				) : null}
				{children}
				<div className="flex shrink-0 items-center rounded-lg border border-border/60 bg-muted/50 p-0.5">
					{viewModes.map(({ mode: value, icon: Icon, label }) => (
						<Button
							key={value}
							type="button"
							variant="ghost"
							size="xs"
							aria-pressed={value === mode}
							className={cn(
								value === mode
									? "bg-background shadow-xs hover:bg-background"
									: "text-muted-foreground",
							)}
							onClick={() => onModeChange(value)}
						>
							<Icon className="size-3.5" aria-hidden />
							{t(label)}
						</Button>
					))}
				</div>
			</div>
		</div>
	);
}
