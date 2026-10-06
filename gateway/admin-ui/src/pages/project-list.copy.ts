/** Project list page copy: origin filter, project table, and the create-project dialog. */

export const zh = {
  // Page header and origin filter
  pageTitle: '项目',
  pageDescription: '统一查看管理员发起和用户发起的工作空间，并配置成员权限。',
  projectCount: '{count} 个项目',
  createProject: '新建项目',
  originFilterAria: '项目来源筛选',
  filterAll: '全部',
  originAdmin: '管理员发起',
  originUser: '用户发起',

  // Project directory section
  sectionTitle: '项目目录',
  recordCount: '{count} 条记录',
  loadingProjects: '正在加载项目',
  emptyTitle: '还没有项目',
  emptyDetail: '管理员项目可使用默认目录或导入现有目录；用户项目由账户在受控项目根目录中创建。',
  colProject: '项目',
  colOrigin: '来源 / 所有者',
  colDirectory: '目录',
  colMembers: '成员',
  colOpen: '打开',
  ownerFallback: '组织管理',
  unknownOwner: '未知所有者',
  membersCount: '{count} 位成员',
  openProjectAria: '打开 {name}',
  openProjectTitle: '打开项目',

  // Create-project dialog
  createDialogDescription: '创建受管目录，或把 Gateway 主机上的现有项目加入工作区。',
  cancel: '取消',
  submitCreate: '创建项目',
  projectNameLabel: '项目名称',
  nameHintManaged: 'Gateway 会在默认项目根目录创建同名目录。',
  nameHintExisting: '用于工作区列表显示，不会重命名现有目录。',
  namePlaceholder: '例如：产品文档',
  directoryFieldLabel: '项目目录',
  directoryModeAria: '项目目录方式',
  modeManaged: '默认目录',
  modeExisting: '现有目录',
  managedTitle: 'Gateway 默认项目目录',
  managedDetail: '创建一个新的受管项目文件夹',
  selectedDirectory: '已选择目录',

  // Create-project API error mapping
  errorNameInvalid: '项目名称不能为空，也不能包含路径分隔符。',
  errorRootNotDirectory: '项目根路径不是目录，请检查 Gateway 配置。',
  errorPathOutsideRoot: '项目目录不在 Gateway 允许的项目根目录内。',
  errorPathNotAbsolute: '项目目录必须是 Gateway 主机上的绝对路径。',
  errorPathReserved: '不能把 Gateway 数据、凭据、运行时或用户目录登记为项目。',
  errorPathOverlap: '该目录与已登记项目重叠，请选择其他目录。',
  errorPathNotFound: '目录不存在。请先在 Gateway 主机上创建该目录，再登记为项目。',
  errorPathNotDirectory: '该路径不是目录。请填写 Gateway 主机上的现有目录。',
  errorPathInaccessible: 'Gateway 无权访问该目录，请检查目录权限。',
  errorDuplicateName: '项目名称已存在。',
} satisfies Record<string, string>

export type ProjectListCopyKey = keyof typeof zh

export const en = {
  // Page header and origin filter
  pageTitle: 'Projects',
  pageDescription: 'View admin-initiated and user-initiated workspaces in one place and configure member permissions.',
  projectCount: '{count} projects',
  createProject: 'New project',
  originFilterAria: 'Project origin filter',
  filterAll: 'All',
  originAdmin: 'Admin-initiated',
  originUser: 'User-initiated',

  // Project directory section
  sectionTitle: 'Project directory',
  recordCount: '{count} records',
  loadingProjects: 'Loading projects',
  emptyTitle: 'No projects yet',
  emptyDetail: 'Admin projects can use the default directory or import an existing directory; user projects are created by accounts under the managed project root.',
  colProject: 'Project',
  colOrigin: 'Origin / Owner',
  colDirectory: 'Directory',
  colMembers: 'Members',
  colOpen: 'Open',
  ownerFallback: 'Organization',
  unknownOwner: 'Unknown owner',
  membersCount: '{count} members',
  openProjectAria: 'Open {name}',
  openProjectTitle: 'Open project',

  // Create-project dialog
  createDialogDescription: 'Create a managed directory, or add an existing project on the Gateway host to the workspace.',
  cancel: 'Cancel',
  submitCreate: 'Create project',
  projectNameLabel: 'Project name',
  nameHintManaged: 'Gateway creates a directory with the same name under the default project root.',
  nameHintExisting: 'Used for display in workspace lists; the existing directory is not renamed.',
  namePlaceholder: 'e.g. Product docs',
  directoryFieldLabel: 'Project directory',
  directoryModeAria: 'Project directory mode',
  modeManaged: 'Default directory',
  modeExisting: 'Existing directory',
  managedTitle: 'Gateway default project directory',
  managedDetail: 'Create a new managed project folder',
  selectedDirectory: 'Selected directory',

  // Create-project API error mapping
  errorNameInvalid: 'The project name must not be empty or contain path separators.',
  errorRootNotDirectory: 'The project root is not a directory; check the Gateway configuration.',
  errorPathOutsideRoot: 'The project directory is not inside the project root allowed by Gateway.',
  errorPathNotAbsolute: 'The project directory must be an absolute path on the Gateway host.',
  errorPathReserved: 'Gateway data, credential, runtime, and user directories cannot be registered as a project.',
  errorPathOverlap: 'This directory overlaps a registered project; choose another directory.',
  errorPathNotFound: 'The directory does not exist. Create it on the Gateway host first, then register it as a project.',
  errorPathNotDirectory: 'This path is not a directory. Enter an existing directory on the Gateway host.',
  errorPathInaccessible: 'Gateway cannot access this directory; check its permissions.',
  errorDuplicateName: 'A project with this name already exists.',
} satisfies Record<ProjectListCopyKey, string>
