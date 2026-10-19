/**
 * ic_ds_* icon set — Lucide-backed glyphs (lucide-react, ISC) plus a small
 * Phosphor-backed set (MIT, path data inlined via `ph()`). Every glyph rides
 * currentColor and takes {size, className}; Lucide stroke weight follows the
 * drawn size (2 at ≥16px, 2.2 at 14px, 2.4 at ≤12px). `aria-hidden` stays
 * absent: the a11y tree lists bare svg glyphs as `img`, which the web golden
 * snapshots depend on. A few glyphs stay custom — IconCloseFill14 (heavy
 * filled X, no Lucide analogue), IconTreeCorner8x10 (structural tree-line
 * connector, not an icon metaphor), IconShieldOutline16 (figma shield
 * contour shared with SHIELD_OUTLINE_PATH consumers), and the code-toolbar
 * wrap/nowrap fills (no Lucide analogue).
 */
import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  ArrowUp,
  ArrowUpRight,
  Brain,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  AppWindow,
  Box,
  ChevronsUpDown,
  Compass,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  ClipboardList,
  Clock,
  CodeXml,
  Columns2,
  Copy,
  Cpu,
  Database,
  Download,
  Ellipsis,
  Eye,
  FilePen,
  FileText,
  FoldHorizontal,
  FoldVertical,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitBranch,
  Globe,
  FolderRoot,
  Lightbulb,
  Link,
  List,
  ListChecks,
  MessageSquareText,
  ListTodo,
  LogOut,
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
  Info,
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
  UserRoundCog,
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

/** Stroke weight by drawn size, per the reference kits (2 / 2.2 / 2.4). */
const strokeFor = (size: number): number => (size <= 12 ? 2.4 : size < 16 ? 2.2 : 2)

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

/** Phosphor path data on the 256 grid (MIT, © Phosphor Icons). A two-member
 * tuple renders duotone: the secondary layer first at 45% opacity, then the
 * primary shape — the CDS dual-layer protocol. */
const PH = {
  export: 'M216,112v96a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V112A16,16,0,0,1,56,96H80a8,8,0,0,1,0,16H56v96H200V112H176a8,8,0,0,1,0-16h24A16,16,0,0,1,216,112ZM93.66,69.66,120,43.31V136a8,8,0,0,0,16,0V43.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,69.66Z',
  calendar: ['M216,48V88H40V48a8,8,0,0,1,8-8H208A8,8,0,0,1,216,48Z', 'M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Zm-96-88v64a8,8,0,0,1-16,0V132.94l-4.42,2.22a8,8,0,0,1-7.16-14.32l16-8A8,8,0,0,1,112,120Zm59.16,30.45L152,176h16a8,8,0,0,1,0,16H136a8,8,0,0,1-6.4-12.8l28.78-38.37A8,8,0,1,0,145.07,132a8,8,0,1,1-13.85-8A24,24,0,0,1,176,136,23.76,23.76,0,0,1,171.16,150.45Z'],
  squaresFour: ['M112,56v48a8,8,0,0,1-8,8H56a8,8,0,0,1-8-8V56a8,8,0,0,1,8-8h48A8,8,0,0,1,112,56Zm88-8H152a8,8,0,0,0-8,8v48a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V56A8,8,0,0,0,200,48Zm-96,96H56a8,8,0,0,0-8,8v48a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V152A8,8,0,0,0,104,144Zm96,0H152a8,8,0,0,0-8,8v48a8,8,0,0,0,8,8h48a8,8,0,0,0,8-8V152A8,8,0,0,0,200,144Z', 'M200,136H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,200,136Zm0,64H152V152h48v48ZM104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48v48Zm-96,32H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48v48Z'],
  treeStructure: 'M160,112h48a16,16,0,0,0,16-16V48a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16V64H128a24,24,0,0,0-24,24v32H72v-8A16,16,0,0,0,56,96H24A16,16,0,0,0,8,112v32a16,16,0,0,0,16,16H56a16,16,0,0,0,16-16v-8h32v32a24,24,0,0,0,24,24h16v16a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V160a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16v16H128a8,8,0,0,1-8-8V88a8,8,0,0,1,8-8h16V96A16,16,0,0,0,160,112ZM56,144H24V112H56v32Zm104,16h48v48H160Zm0-112h48V96H160Z',
  arrowsOut: 'M216,48V96a8,8,0,0,1-16,0V67.31l-42.34,42.35a8,8,0,0,1-11.32-11.32L188.69,56H160a8,8,0,0,1,0-16h48A8,8,0,0,1,216,48ZM98.34,146.34,56,188.69V160a8,8,0,0,0-16,0v48a8,8,0,0,0,8,8H96a8,8,0,0,0,0-16H67.31l42.35-42.34a8,8,0,0,0-11.32-11.32ZM208,152a8,8,0,0,0-8,8v28.69l-42.34-42.35a8,8,0,0,0-11.32,11.32L188.69,200H160a8,8,0,0,0,0,16h48a8,8,0,0,0,8-8V160A8,8,0,0,0,208,152ZM67.31,56H96a8,8,0,0,0,0-16H48a8,8,0,0,0-8,8V96a8,8,0,0,0,16,0V67.31l42.34,42.35a8,8,0,0,0,11.32-11.32Z',
  arrowsIn: 'M144,104V64a8,8,0,0,1,16,0V84.69l42.34-42.35a8,8,0,0,1,11.32,11.32L171.31,96H192a8,8,0,0,1,0,16H152A8,8,0,0,1,144,104Zm-40,40H64a8,8,0,0,0,0,16H84.69L42.34,202.34a8,8,0,0,0,11.32,11.32L96,171.31V192a8,8,0,0,0,16,0V152A8,8,0,0,0,104,144Zm67.31,16H192a8,8,0,0,0,0-16H152a8,8,0,0,0-8,8v40a8,8,0,0,0,16,0V171.31l42.34,42.35a8,8,0,0,0,11.32-11.32ZM104,56a8,8,0,0,0-8,8V84.69L53.66,42.34A8,8,0,0,0,42.34,53.66L84.69,96H64a8,8,0,0,0,0,16h40a8,8,0,0,0,8-8V64A8,8,0,0,0,104,56Z',
  cornersOut: 'M216,48V88a8,8,0,0,1-16,0V56H168a8,8,0,0,1,0-16h40A8,8,0,0,1,216,48ZM88,200H56V168a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H88a8,8,0,0,0,0-16Zm120-40a8,8,0,0,0-8,8v32H168a8,8,0,0,0,0,16h40a8,8,0,0,0,8-8V168A8,8,0,0,0,208,160ZM88,40H48a8,8,0,0,0-8,8V88a8,8,0,0,0,16,0V56H88a8,8,0,0,0,0-16Z',
  spinnerGap: 'M136,32V64a8,8,0,0,1-16,0V32a8,8,0,0,1,16,0Zm88,88H192a8,8,0,0,0,0,16h32a8,8,0,0,0,0-16Zm-45.09,47.6a8,8,0,0,0-11.31,11.31l22.62,22.63a8,8,0,0,0,11.32-11.32ZM128,184a8,8,0,0,0-8,8v32a8,8,0,0,0,16,0V192A8,8,0,0,0,128,184ZM77.09,167.6,54.46,190.22a8,8,0,0,0,11.32,11.32L88.4,178.91A8,8,0,0,0,77.09,167.6ZM72,128a8,8,0,0,0-8-8H32a8,8,0,0,0,0,16H64A8,8,0,0,0,72,128ZM65.78,54.46A8,8,0,0,0,54.46,65.78L77.09,88.4A8,8,0,0,0,88.4,77.09Z',
  usersThree: 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z',
} as const

const ph =
  (paths: string | readonly [string, string], drawnSize: number) =>
    ({ size = drawnSize, className, ...rest }: GlyphProps) => {
      const [sub, main] = typeof paths === 'string' ? [undefined, paths] : paths
      return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className} aria-hidden={undefined} {...rest}>
          {sub ? <path d={sub} opacity={0.45} /> : null}
          <path d={main} />
        </svg>
      )
    }

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
/** ic_ds_split_panes_outline_16 */
export const IconSplitPanesOutline16 = glyph(Columns2, 16)
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
export const IconShareOutline16 = ph(PH.export, 16)
/** ic_ds_edit_outline_16 */
export const IconEditOutline16 = glyph(Pencil, 16)
/** ic_ds_think_outline_14 */
export const IconThinkOutline14 = glyph(Lightbulb, 14)
/** ic_ds_think_outline_16 */
export const IconThinkOutline16 = glyph(Lightbulb, 16)
/** ic_ds_agent_preset_outline_16 */
export const IconAgentPresetOutline16 = glyph(UserRoundCog, 16)
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
/** ic_ds_users_outline_16 */
export const IconUsersOutline16 = ph(PH.usersThree, 16)
/** ic_ds_send_outline_16 */
export const IconSendOutline16 = glyph(ArrowUp, 16)
/** ic_ds_stop_fill_16 */
export const IconStopFill16 = glyph(Square, 16, true)
/** ic_ds_paperclip_outline_16 */
export const IconPaperclipOutline16 = glyph(Paperclip, 16)
/** ic_ds_loading_outline_16 */
export const IconLoadingOutline16 = ph(PH.spinnerGap, 16)
/** ic_ds_download_outline_16 */
export const IconDownloadOutline16 = glyph(Download, 16)
/** ic_ds_play_outline_16 */
export const IconPlayOutline16 = glyph(Play, 16)
/** ic_ds_pause_outline_16 */
export const IconPauseOutline16 = glyph(Pause, 16)
/** ic_ds_fullscreen_outline_16 */
export const IconFullscreenOutline16 = ph(PH.arrowsOut, 16)
/** ic_ds_code_outline_16 */
export const IconCodeOutline16 = glyph(CodeXml, 16)
/** ic_ds_cordis_plugin_outline_14 */
export const IconCordisPluginOutline14 = glyph(Puzzle, 14)
/** ic_ds_plugins_outline_16 */
export const IconPluginsOutline16 = glyph(Puzzle, 16)
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
export const IconWorkspaceOutline16 = glyph(FolderRoot, 16)
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
export const IconSkillOutline16 = ph(PH.squaresFour, 16)
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
export const IconWorkspaceTreeOutline16 = ph(PH.treeStructure, 16)
/** ic_ds_flat_list_outline_16 */
export const IconFlatListOutline16 = glyph(List, 16)
/** ic_ds_chevrons_up_down_outline_16 */
export const IconChevronsUpDownOutline16 = glyph(ChevronsUpDown, 16)
/** ic_ds_plan_outline_14 */
export const IconPlanOutline14 = glyph(ClipboardList, 14)
/** ic_ds_compact_outline_16 */
export const IconCompactOutline16 = glyph(FoldVertical, 16)
/** ic_ds_shield_outline_16 */
/** Permission row glyph of the composer menu: the shield contour without a mode mark. */
export const SHIELD_OUTLINE_PATH = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'

/** Stroke width of {@link SHIELD_OUTLINE_PATH}. */
export const SHIELD_OUTLINE_STROKE = '1.31831'

/** Permission row glyph of the composer menu: the shield contour alone. */
export const IconShieldOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={SHIELD_OUTLINE_STROKE} strokeLinejoin="round" />
  </svg>
)
/** ic_ds_brain_outline_16 */
export const IconBrainOutline16 = glyph(Brain, 16)

/** ic_ds_model_outline_16 */
export const IconModelOutline16 = glyph(Cpu, 16)
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
export const IconMinimizeOutline16 = ph(PH.arrowsIn, 16)
/** ic_ds_maximize_outline_16 */
export const IconMaximizeOutline16 = ph(PH.cornersOut, 16)
/** ic_ds_restore_outline_16 */
export const IconRestoreOutline16 = glyph(FoldHorizontal, 16)
/** ic_ds_calendar_outline_14 */
export const IconCalendarOutline14 = ph(PH.calendar, 14)
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

/** Wrap-enabled state glyph for the code-card toolbar. */
export const IconWrapFill16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z" fill="currentColor" />
    <path d="M2 15H1V1H2V15Z" fill="currentColor" />
    <path d="M15 15H14V1H15V15Z" fill="currentColor" />
  </svg>
)

/** Wrap-disabled state glyph for the code-card toolbar. */
export const IconNowrapFill16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M2 15H1V1H2V15Z" fill="currentColor" />
    <path d="M12.3535 7.64645C12.5487 7.84171 12.5487 8.15829 12.3535 8.35355L9.85352 10.8535L9.14648 10.1465L10.793 8.5H3.5V7.5H10.793L9.14648 5.85352L9.85352 5.14648L12.3535 7.64645Z" fill="currentColor" />
    <path d="M15 15H14V1H15V15Z" fill="currentColor" />
  </svg>
)
