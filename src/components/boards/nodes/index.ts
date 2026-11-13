import { FrameNode } from './FrameNode'
import { TextNode } from './TextNode'
import { NoteNode } from './NoteNode'
import { LinkNode } from './LinkNode'
import { EntityNode } from './EntityNode'
import { PersonNode } from './PersonNode'
import { WidgetNode } from './WidgetNode'

export const nodeTypes = {
  frame: FrameNode,
  text: TextNode,
  note: NoteNode,
  link: LinkNode,
  entity: EntityNode,
  person: PersonNode,
  widget: WidgetNode,
}
