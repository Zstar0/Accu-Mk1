/** The Tasks page's tab axis: the flyout's labels and order. Four map 1:1 to
 *  the API's `FlagTab`; `unread` and `activity` are FE-only tabs. */
export type TasksTab =
  | 'assigned'
  | 'raised'
  | 'watching'
  | 'all_open'
  | 'unread'
  | 'activity'

export const TASKS_TABS: { value: TasksTab; label: string }[] = [
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'raised', label: 'Raised by me' },
  { value: 'watching', label: 'Watching' },
  { value: 'all_open', label: 'All open' },
  { value: 'unread', label: 'Unread' },
  { value: 'activity', label: 'Activity' },
]

export const DEFAULT_TASKS_TAB: TasksTab = 'assigned'
