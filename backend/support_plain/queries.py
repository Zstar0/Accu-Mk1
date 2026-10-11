"""Fixed Plain GraphQL documents (spec 3.2). Reads in ALL, writes in MUTATIONS; the client sends nothing else."""

WORKSPACE = "query Workspace { myWorkspace { id } }"

CUSTOMER_BY_EMAIL = """query CustomerByEmail($email: String!) {
  customerByEmail(email: $email) { id fullName }
}"""

_THREAD_FIELDS = """id ref title previewText status priority isTestThread
      createdAt { iso8601 }
      updatedAt { iso8601 }
      customer { id fullName }
      labels { id labelType { id name } }
      assignedTo { __typename ... on User { id fullName } ... on MachineUser { id fullName } }
      lastInboundMessageInfo { timestamp { iso8601 } }
      lastOutboundMessageInfo { timestamp { iso8601 } }"""

THREADS = """query CustomerThreads($customerIds: [ID!]!, $after: String) {
  threads(first: 50, after: $after, filters: {customerIds: $customerIds, isMarkedAsSpam: false}) {
    pageInfo { hasNextPage endCursor }
    edges { node { %s } }
  }
}""" % _THREAD_FIELDS

_ACTOR = """__typename
        ... on UserActor { userId user { fullName } }
        ... on CustomerActor { customer { fullName } }
        ... on MachineUserActor { machineUser { fullName } }"""

# `text` is aliased per entry type: Plain declares it String on some and String! on others,
# which GraphQL rejects as a field conflict in one selection.
THREAD = """query Thread($threadId: ID!, $after: String) {
  thread(threadId: $threadId) {
    %s
    timelineEntries(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        timestamp { iso8601 }
        actor { %s }
        entry {
          __typename
          ... on EmailEntry { subject textContent hasMoreTextContent fullTextContent from { name email } }
          ... on ChatEntry { chatText: text }
          ... on NoteEntry { noteText: text }
          ... on SlackMessageEntry { slackText: text }
          ... on SlackReplyEntry { slackReplyText: text }
          ... on ThreadDiscussionMessageEntry { discussionText: text }
          ... on CustomEntry { title components { __typename ... on ComponentText { text } } }
          ... on ThreadStatusTransitionedEntry { nextStatus }
          ... on ThreadLabelsChangedEntry { nextLabels { labelType { name } } }
          ... on ThreadAssignmentTransitionedEntry { nextAssignee { __typename ... on User { fullName } ... on MachineUser { fullName } } }
          ... on ThreadPriorityChangedEntry { nextPriority }
        }
      } }
    }
  }
}""" % (_THREAD_FIELDS, _ACTOR)

USER_BY_EMAIL = """query UserByEmail($email: String!) {
  userByEmail(email: $email) { id fullName publicName email isDeleted }
}"""

USERS = """query Users($after: String) {
  users(first: 100, after: $after, filters: {isAssignableToThread: true}) {
    pageInfo { hasNextPage endCursor }
    edges { node { id fullName email isDeleted } }
  }
}"""

LABEL_TYPES = """query LabelTypes($after: String) {
  labelTypes(first: 100, after: $after, filters: {isArchived: false}) {
    pageInfo { hasNextPage endCursor }
    edges { node { id name color } }
  }
}"""

ALL = frozenset({WORKSPACE, CUSTOMER_BY_EMAIL, THREADS, THREAD, USER_BY_EMAIL, USERS, LABEL_TYPES})

_ERR = "error { message type code }"


def _m(name: str, field: str, input_type: str) -> str:
    return "mutation %s($input: %s!) { %s(input: $input) { %s } }" % (name, input_type, field, _ERR)


REPLY = _m("ReplyToThread", "replyToThread", "ReplyToThreadInput")
NOTE = _m("CreateNote", "createNote", "CreateNoteInput")
MARK_DONE = _m("MarkThreadAsDone", "markThreadAsDone", "MarkThreadAsDoneInput")
MARK_TODO = _m("MarkThreadAsTodo", "markThreadAsTodo", "MarkThreadAsTodoInput")
SNOOZE = _m("SnoozeThread", "snoozeThread", "SnoozeThreadInput")
ASSIGN = _m("AssignThread", "assignThread", "AssignThreadInput")
UNASSIGN = _m("UnassignThread", "unassignThread", "UnassignThreadInput")
PRIORITY = _m("ChangeThreadPriority", "changeThreadPriority", "ChangeThreadPriorityInput")
ADD_LABELS = _m("AddLabels", "addLabels", "AddLabelsInput")
REMOVE_LABELS = _m("RemoveLabels", "removeLabels", "RemoveLabelsInput")

MUTATIONS = frozenset({REPLY, NOTE, MARK_DONE, MARK_TODO, SNOOZE, ASSIGN, UNASSIGN, PRIORITY, ADD_LABELS,
                       REMOVE_LABELS})
