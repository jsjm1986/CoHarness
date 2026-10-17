/** Localized copy for the project activity panel. */
const zh = {
  'type.label': '项目动态',
  'guide.title': '项目动态',
  'guide.description': '成员发送的消息与选择的回答',
  'grouping.time': '时间',
  'grouping.conversation': '会话',
  'grouping.member': '成员',
  'filter.allMembers': '全部成员',
  'toolbar.refresh': '刷新',
  'feed.loadMore': '加载更早',
  'feed.loading': '加载中…',
  'feed.failed': '加载失败，点击刷新重试',
  'feed.empty': '还没有成员活动',
  'row.answered': '回答',
  'row.untitledConversation': '未命名会话',
  'row.openConversation': '打开会话',
  'row.reveal': '跳到这条消息',
}

/** English copy, keyed identically to {@link zh}. */
const en: typeof zh = {
  'type.label': 'Activity',
  'guide.title': 'Project activity',
  'guide.description': 'Messages members sent and answers they chose',
  'grouping.time': 'Time',
  'grouping.conversation': 'Conversation',
  'grouping.member': 'Member',
  'filter.allMembers': 'All members',
  'toolbar.refresh': 'Refresh',
  'feed.loadMore': 'Load earlier',
  'feed.loading': 'Loading…',
  'feed.failed': 'Load failed — refresh to retry',
  'feed.empty': 'No member activity yet',
  'row.answered': 'answered',
  'row.untitledConversation': 'Untitled conversation',
  'row.openConversation': 'Open conversation',
  'row.reveal': 'Jump to this message',
}

export { zh, en }
/** Dictionary keys shared by {@link zh} and {@link en}. */
export type ActivityKey = keyof typeof zh
