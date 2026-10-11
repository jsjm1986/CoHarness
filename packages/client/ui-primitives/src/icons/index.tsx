/**
 * ic_ds_* icon set — Lucide-backed glyphs (lucide-react, ISC). Every glyph
 * rides currentColor and takes {size, className}; stroke weight follows the
 * drawn size (2.5 at ≥16px, 2.6 at 14px, 2.8 at ≤12px). `aria-hidden` stays
 * absent: the a11y tree lists bare svg glyphs as `img`, which the web golden
 * snapshots depend on. Two glyphs stay custom — IconCloseFill14 (heavy
 * filled X, no Lucide analogue) and IconTreeCorner8x10 (structural
 * tree-line connector, not an icon metaphor).
 */
import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  ArrowUp,
  ArrowUpRight,
  Blocks,
  Bot,
  Brain,
  BrainCircuit,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  AppWindow,
  Box,
  Calendar,
  ChevronsUpDown,
  Compass,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  ClipboardList,
  Clock,
  CodeXml,
  Copy,
  Database,
  Download,
  Ellipsis,
  Eye,
  FilePen,
  FileText,
  FoldVertical,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Gauge,
  GitBranch,
  Globe,
  Layers,
  Lightbulb,
  Link,
  List,
  ListChecks,
  MessageSquareText,
  ListTodo,
  LoaderCircle,
  LogOut,
  Maximize2,
  Mic,
  Monitor,
  Moon,
  PackageCheck,
  PanelLeft,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  Share,
  Info,
  Minimize2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  Sun,
  Target,
  ThumbsDown,
  ThumbsUp,
  Trash,
  Terminal,
  TriangleAlert,
  User,
  WandSparkles,
  SquareTerminal,
  TextWrap,
  Wrench,
  X,
} from 'lucide-react'
import type { IconProps } from './props.ts'

export type { IconProps } from './props.ts'

/** Icon props plus Lucide's SVG passthrough: decorative callers pass
 * `aria-hidden` and styling attributes like `data-role-icon` straight through
 * to the rendered svg. The shared set itself keeps `aria-hidden` absent so
 * glyphs stay `img` in the accessibility tree. */
type GlyphProps = IconProps & Omit<LucideProps, 'size' | 'width' | 'height' | 'color' | 'strokeWidth' | 'fill' | 'ref'>

/** Stroke weight by drawn size. Lucide's 24-grid default (2) renders ~1.3px
 * at 14-16px draws — too light against filled glyphs — so the ladder holds
 * the rendered stem at roughly 1.5-1.7px (2.5 / 2.6 / 2.8). */
const strokeFor = (size: number): number => (size <= 12 ? 2.8 : size < 16 ? 2.6 : 2.5)

const glyph =
  (Lucide: LucideIcon, drawnSize: number, filled = false) =>
    ({ size = drawnSize, className, ...rest }: GlyphProps) => (
      <Lucide
        size={size}
        strokeWidth={strokeFor(drawnSize)}
        fill={filled ? 'currentColor' : 'none'}
        className={className}
        aria-hidden={undefined}
        {...rest}
      />
    )

/** ic_ds_new_chat_outline_16 */
export const IconNewChatOutline16 = glyph(SquarePen, 16)
/** ic_ds_search_outline_16 */
export const IconSearchOutline16 = glyph(Search, 16)
/** ic_ds_globe_outline_14 */
export const IconGlobeOutline14 = glyph(Globe, 14)
/** ic_ds_settings_outline_14 */
export const IconSettingsOutline14 = glyph(Settings, 14)
/** ic_ds_settings_outline_16 */
export const IconSettingsOutline16 = glyph(Settings, 16)
/** ic_ds_panel_left_outline_16 */
export const IconPanelLeftOutline16 = glyph(PanelLeft, 16)
/** ic_ds_ellipsis_outline_16 */
export const IconEllipsisOutline16 = glyph(Ellipsis, 16)
/** ic_ds_plus_outline_16 */
export const IconPlusOutline16 = glyph(Plus, 16)
/** ic_ds_check_outline_16 */
export const IconCheckOutline16 = glyph(Check, 16)
/** ic_ds_check_outline_14 */
export const IconCheckOutline14 = glyph(Check, 14)
/** ic_ds_branch_outline_16 */
export const IconBranchOutline16 = glyph(GitBranch, 16)
/** ic_ds_chevron_down_outline_14 */
export const IconChevronDownOutline14 = glyph(ChevronDown, 14)
/** ic_ds_chevron_left_outline_14 */
export const IconChevronLeftOutline14 = glyph(ChevronLeft, 14)
/** ic_ds_chevron_right_outline_14 */
export const IconChevronRightOutline14 = glyph(ChevronRight, 14)
/** ic_ds_triangle_right_fill_14 */
export const IconTriangleRightFill14 = glyph(Play, 14, true)
/** ic_ds_chevron_up_outline_14 */
export const IconChevronUpOutline14 = glyph(ChevronUp, 14)
/** ic_ds_close_outline_16 */
export const IconCloseOutline16 = glyph(X, 16)
/** ic_ds_close_fill_14 — kept custom: the heavy filled X has no Lucide match. */
export const IconCloseFill14 = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z"
      fill="currentColor"
    />
  </svg>
)
/** ic_ds_copy_outline_16 */
export const IconCopyOutline16 = glyph(Copy, 16)
/** ic_ds_refresh_outline_16 */
export const IconRefreshOutline16 = glyph(RefreshCw, 16)
/** ic_ds_refresh_outline_14 */
export const IconRefreshOutline14 = glyph(RefreshCw, 14)
/** ic_ds_like_outline_16 */
export const IconLikeOutline16 = glyph(ThumbsUp, 16)
/** ic_ds_like_fill_16 */
export const IconLikeFill16 = glyph(ThumbsUp, 16, true)
/** ic_ds_dislike_outline_16 */
export const IconDislikeOutline16 = glyph(ThumbsDown, 16)
/** ic_ds_dislike_fill_16 */
export const IconDislikeFill16 = glyph(ThumbsDown, 16, true)
/** ic_ds_share_outline_16 */
export const IconShareOutline16 = glyph(Share, 16)
/** ic_ds_edit_outline_16 */
export const IconEditOutline16 = glyph(Pencil, 16)
/** ic_ds_think_outline_14 */
export const IconThinkOutline14 = glyph(Lightbulb, 14)
/** ic_ds_think_outline_16 */
export const IconThinkOutline16 = glyph(Lightbulb, 16)
/** ic_ds_agent_preset_outline_16 */
export const IconAgentPresetOutline16 = glyph(Bot, 16)
/** ic_ds_browse_outline_16 — documents browser. */
export const IconBrowseOutline16 = glyph(FileText, 16)
/** ic_ds_link_outline_14 */
export const IconLinkOutline14 = glyph(Link, 14)
/** ic_ds_link_outline_16 */
export const IconLinkOutline16 = glyph(Link, 16)
/** ic_ds_right_up_outline_14 */
export const IconRightUpOutline14 = glyph(ArrowUpRight, 14)
/** ic_ds_right_up_outline_16 */
export const IconRightUpOutline16 = glyph(ArrowUpRight, 16)
/** ic_ds_logout_outline_16 */
export const IconLogoutOutline16 = glyph(LogOut, 16)
/** ic_ds_enhance_outline_16 */
export const IconEnhanceOutline16 = glyph(WandSparkles, 16)
/** ic_ds_trash_outline_16 */
export const IconTrashOutline16 = glyph(Trash, 16)
/** ic_ds_warning_outline_16 */
export const IconWarningOutline16 = glyph(TriangleAlert, 16)
/** ic_ds_user_outline_16 */
export const IconUserOutline16 = glyph(User, 16)
/** ic_ds_send_outline_16 */
export const IconSendOutline16 = glyph(ArrowUp, 16)
/** ic_ds_stop_fill_16 */
export const IconStopFill16 = glyph(Square, 16, true)
/** ic_ds_paperclip_outline_16 */
export const IconPaperclipOutline16 = glyph(Paperclip, 16)
/** ic_ds_loading_outline_16 */
export const IconLoadingOutline16 = glyph(LoaderCircle, 16)
/** ic_ds_download_outline_16 */
export const IconDownloadOutline16 = glyph(Download, 16)
/** ic_ds_play_outline_16 */
export const IconPlayOutline16 = glyph(Play, 16)
/** ic_ds_pause_outline_16 */
export const IconPauseOutline16 = glyph(Pause, 16)
/** ic_ds_fullscreen_outline_16 */
export const IconFullscreenOutline16 = glyph(Maximize2, 16)
/** ic_ds_code_outline_16 */
export const IconCodeOutline16 = glyph(CodeXml, 16)
/** ic_ds_cordis_plugin_outline_14 */
export const IconCordisPluginOutline14 = glyph(Puzzle, 14)
/** ic_ds_api_outline_14 */
export const IconApiOutline14 = glyph(SquareTerminal, 14)
/** ic_ds_personalization_outline_16 */
export const IconPersonalizationOutline16 = glyph(SlidersHorizontal, 16)
/** ic_ds_project_add_outline_16 */
export const IconProjectAddOutline16 = glyph(FolderPlus, 16)
/** ic_ds_folder_open_outline_16 */
export const IconFolderOpenOutline16 = glyph(FolderOpen, 16)
/** ic_ds_folder_open_16 */
export const IconFolderOpen16 = glyph(FolderOpen, 16)
/** ic_ds_folder_close_16 */
export const IconFolderClose16 = glyph(Folder, 16)
/** ic_ds_workspace_outline_16 */
export const IconWorkspaceOutline16 = glyph(Layers, 16)
/** ic_ds_tree_corner_8x10 — kept custom: structural connector, not a glyph. */
export const IconTreeCorner8x10 = ({ size = 10, className }: IconProps) => (
  <svg width={(size * 8) / 10} height={size} className={className} viewBox="-0.5 0 8.5 10.5" fill="none">
    <path d="M0 0L-0.5 0L-0.5 7L0 7L0 7L0.5 7L0.5 0L0 0ZM3 10L3 10.5L8 10.5L8 10L8 9.5L3 9.5L3 10ZM0 7L-0.5 7C-0.5 8.933 1.067 10.5 3 10.5L3 10L3 9.5C1.61929 9.5 0.5 8.38071 0.5 7L0 7Z" fill="currentColor"/>
  </svg>
)
/** ic_ds_light_outline_16 */
export const IconLightOutline16 = glyph(Sun, 16)
/** ic_ds_dark_outline_16 */
export const IconDarkOutline16 = glyph(Moon, 16)
/** ic_ds_follow_system_outline_16 */
export const IconFollowsystemOutline16 = glyph(Monitor, 16)
/** ic_ds_data_outline_16 */
export const IconDataOutline16 = glyph(ChartNoAxesColumn, 16)
/** ic_ds_database_outline_16 */
export const IconDatabaseOutline16 = glyph(Database, 16)
/** ic_ds_clock_outline_16 */
export const IconClockOutline16 = glyph(Clock, 16)
/** ic_ds_gauge_outline_16 */
export const IconGaugeOutline16 = glyph(Gauge, 16)
/** ic_ds_send_outline_14 */
export const IconSendOutline14 = glyph(ArrowUp, 14)
/** ic_ds_queue_outline_14 */
export const IconQueueOutline14 = glyph(MessageSquareText, 14)
/** ic_ds_checklist_outline_14 */
export const IconChecklistOutline14 = glyph(ListChecks, 14)
/** ic_ds_list_pen_outline_16 */
export const IconListPenOutline16 = glyph(ListTodo, 16)
/** ic_ds_goal_outline_16 */
export const IconGoalOutline16 = glyph(Target, 16)
/** ic_ds_sparkle_16 */
export const IconSparkle16 = glyph(Sparkles, 16)
/** ic_ds_inspect_outline_12 */
export const IconInspectOutline12 = glyph(ScanSearch, 12)
/** ic_ds_skill_outline_16 */
export const IconSkillOutline16 = glyph(Blocks, 16)
/** ic_ds_deliver_doc_16 */
export const IconDeliverDoc16 = glyph(FileText, 16)
/** ic_ds_question_outline_14 */
export const IconQuestionOutline14 = glyph(CircleQuestionMark, 14)
/** ic_ds_archive_outline_20 */
export const IconArchiveOutline20 = glyph(Archive, 20)
/** ic_ds_archive_outline_16 */
export const IconArchiveOutline16 = glyph(Archive, 16)
/** ic_ds_unarchive_outline_16 */
export const IconUnarchiveOutline16 = glyph(ArchiveRestore, 16)
/** ic_ds_archive_check_outline_16 — "only archived" filter. */
export const IconArchiveCheckOutline16 = glyph(PackageCheck, 16)
/** ic_ds_archive_off_outline_16 */
export const IconArchiveOffOutline16 = glyph(ArchiveX, 16)
/** ic_ds_workspace_tree_outline_16 */
export const IconWorkspaceTreeOutline16 = glyph(FolderTree, 16)
/** ic_ds_flat_list_outline_16 */
export const IconFlatListOutline16 = glyph(List, 16)
/** ic_ds_chevrons_up_down_outline_16 */
export const IconChevronsUpDownOutline16 = glyph(ChevronsUpDown, 16)
/** ic_ds_plan_outline_14 */
export const IconPlanOutline14 = glyph(ClipboardList, 14)
/** ic_ds_compact_outline_16 */
export const IconCompactOutline16 = glyph(FoldVertical, 16)
/** ic_ds_shield_outline_16 */
export const IconShieldOutline16 = glyph(Shield, 16)
/** ic_ds_brain_outline_16 */
export const IconBrainOutline16 = glyph(Brain, 16)

/** ic_ds_model_outline_16 */
export const IconModelOutline16 = glyph(BrainCircuit, 16)
/** ic_ds_wrap_lines_outline_16 */
export const IconWrapLinesOutline16 = glyph(TextWrap, 16)
/** ic_ds_pin_outline_16 */
export const IconPinOutline16 = glyph(Pin, 16)
/** ic_ds_pin_fill_16 */
export const IconPinFill16 = glyph(Pin, 16, true)
/** ic_ds_microphone_outline_16 */
export const IconMicrophoneOutline16 = glyph(Mic, 16)

/** ic_ds_terminal_outline_16 */
export const IconTerminalOutline16 = glyph(Terminal, 16)
/** ic_ds_info_outline_16 */
export const IconInfoOutline16 = glyph(Info, 16)
/** ic_ds_minimize_outline_16 */
export const IconMinimizeOutline16 = glyph(Minimize2, 16)
/** ic_ds_calendar_outline_14 */
export const IconCalendarOutline14 = glyph(Calendar, 14)
/** ic_ds_compass_outline_16 */
export const IconCompassOutline16 = glyph(Compass, 16)
/** ic_ds_box_outline_16 */
export const IconBoxOutline16 = glyph(Box, 16)
/** ic_ds_eye_outline_16 */
export const IconEyeOutline16 = glyph(Eye, 16)
/** ic_ds_file_pen_outline_16 */
export const IconFilePenOutline16 = glyph(FilePen, 16)
/** ic_ds_shield_check_outline_16 */
export const IconShieldCheckOutline16 = glyph(ShieldCheck, 16)
/** ic_ds_shield_alert_outline_16 */
export const IconShieldAlertOutline16 = glyph(ShieldAlert, 16)
/** ic_ds_shield_x_outline_16 */
export const IconShieldXOutline16 = glyph(ShieldX, 16)
/** ic_ds_circle_check_outline_16 */
export const IconCircleCheckOutline16 = glyph(CircleCheck, 16)
/** ic_ds_circle_dashed_outline_16 */
export const IconCircleDashedOutline16 = glyph(CircleDashed, 16)
/** ic_ds_wrench_outline_16 */
export const IconWrenchOutline16 = glyph(Wrench, 16)
/** ic_ds_app_window_outline_16 */
export const IconAppWindowOutline16 = glyph(AppWindow, 16)
