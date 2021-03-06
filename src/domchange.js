const {Fragment, DOMParser} = require("prosemirror-model")
const {Selection} = require("prosemirror-state")
const {Mapping} = require("prosemirror-transform")

const {TrackMappings} = require("./trackmappings")
const {selectionBetween} = require("./selection")
const {selectionCollapsed} = require("./dom")

class DOMChange {
  constructor(view, composing) {
    this.view = view
    this.state = view.state
    this.composing = composing
    this.from = this.to = null
    this.timeout = composing ? null : setTimeout(() => this.finish(), DOMChange.commitTimeout)
    this.trackMappings = new TrackMappings(view.state)

    // If there have been changes since this DOM update started, we must
    // map our start and end positions, as well as the new selection
    // positions, through them. This tracks that mapping.
    this.mapping = new Mapping
    this.mappingTo = view.state
  }

  addRange(from, to) {
    if (this.from == null) {
      this.from = from
      this.to = to
    } else {
      this.from = Math.min(from, this.from)
      this.to = Math.max(to, this.to)
    }
  }

  changedRange() {
    if (this.from == null) return rangeAroundSelection(this.state.selection)
    let $from = this.state.doc.resolve(Math.min(this.from, this.state.selection.from)), $to = this.state.doc.resolve(this.to)
    let shared = $from.sharedDepth(this.to)
    return {from: $from.before(shared + 1), to: $to.after(shared + 1)}
  }

  markDirty(range) {
    if (this.from == null) this.view.docView.markDirty((range = range || this.changedRange()).from, range.to)
    else this.view.docView.markDirty(this.from, this.to)
  }

  stateUpdated(state) {
    if (this.trackMappings.getMapping(state, this.mapping)) {
      this.trackMappings.destroy()
      this.trackMappings = new TrackMappings(state)
      this.mappingTo = state
      return true
    } else {
      this.markDirty()
      this.destroy()
      return false
    }
  }

  finish(force) {
    clearTimeout(this.timeout)
    if (this.composing && !force) return
    this.view.domObserver.flush()
    let range = this.changedRange()
    this.markDirty(range)

    this.destroy()
    readDOMChange(this.view, this.mapping, this.state, range)

    // If the reading didn't result in a view update, force one by
    // resetting the view to its current state.
    if (this.view.docView.dirty) this.view.updateState(this.view.state)
  }

  destroy() {
    clearTimeout(this.timeout)
    this.trackMappings.destroy()
    this.view.inDOMChange = null
  }

  compositionEnd() {
    if (this.composing) {
      this.composing = false
      this.timeout = setTimeout(() => this.finish(), 50)
    }
  }

  static start(view, composing) {
    if (view.inDOMChange) {
      if (composing) {
        clearTimeout(view.inDOMChange.timeout)
        view.inDOMChange.composing = true
      }
    } else {
      view.inDOMChange = new DOMChange(view, composing)
    }
    return view.inDOMChange
  }
}
DOMChange.commitTimeout = 20
exports.DOMChange = DOMChange

// Note that all referencing and parsing is done with the
// start-of-operation selection and document, since that's the one
// that the DOM represents. If any changes came in in the meantime,
// the modification is mapped over those before it is applied, in
// readDOMChange.

function parseBetween(view, oldState, range) {
  let {node: parent, fromOffset, toOffset, from, to} = view.docView.parseRange(range.from, range.to)

  let domSel = view.root.getSelection(), find = null, anchor = domSel.anchorNode
  if (anchor && view.dom.contains(anchor.nodeType == 1 ? anchor : anchor.parentNode)) {
    find = [{node: anchor, offset: domSel.anchorOffset}]
    if (!selectionCollapsed(domSel))
      find.push({node: domSel.focusNode, offset: domSel.focusOffset})
  }
  let startDoc = oldState.doc
  let parser = view.someProp("domParser") || DOMParser.fromSchema(view.state.schema)
  let $from = startDoc.resolve(from)
  let sel = null, doc = parser.parse(parent, {
    topNode: $from.parent.copy(),
    topStart: $from.index(),
    topOpen: true,
    from: fromOffset,
    to: toOffset,
    preserveWhitespace: $from.parent.type.spec.code ? "full" : true,
    editableContent: true,
    findPositions: find,
    ruleFromNode,
    context: $from
  })
  if (find && find[0].pos != null) {
    let anchor = find[0].pos, head = find[1] && find[1].pos
    if (head == null) head = anchor
    sel = {anchor: anchor + from, head: head + from}
  }
  return {doc, sel, from, to}
}

function ruleFromNode(dom) {
  let desc = dom.pmViewDesc
  if (desc) return desc.parseRule()
  else if (dom.nodeName == "BR" && dom.parentNode && dom.parentNode.lastChild == dom) return {ignore: true}
}

function isAtEnd($pos, depth) {
  for (let i = depth || 0; i < $pos.depth; i++)
    if ($pos.index(i) + 1 < $pos.node(i).childCount) return false
  return $pos.parentOffset == $pos.parent.content.size
}
function isAtStart($pos, depth) {
  for (let i = depth || 0; i < $pos.depth; i++)
    if ($pos.index(0) > 0) return false
  return $pos.parentOffset == 0
}

function rangeAroundSelection(selection) {
  // Intentionally uses $head/$anchor because those will correspond to the DOM selection
  let $from = selection.$anchor.min(selection.$head), $to = selection.$anchor.max(selection.$head)

  if ($from.sameParent($to) && $from.parent.inlineContent && $from.parentOffset && $to.parentOffset < $to.parent.content.size) {
    let startOff = Math.max(0, $from.parentOffset)
    let size = $from.parent.content.size
    let endOff = Math.min(size, $to.parentOffset)

    if (startOff > 0)
      startOff = $from.parent.childBefore(startOff).offset
    if (endOff < size) {
      let after = $from.parent.childAfter(endOff)
      endOff = after.offset + after.node.nodeSize
    }
    let nodeStart = $from.start()
    return {from: nodeStart + startOff, to: nodeStart + endOff}
  } else {
    for (let depth = 0;; depth++) {
      let fromStart = isAtStart($from, depth + 1), toEnd = isAtEnd($to, depth + 1)
      if (fromStart || toEnd || $from.index(depth) != $to.index(depth) || $to.node(depth).isTextblock) {
        let from = $from.before(depth + 1), to = $to.after(depth + 1)
        if (fromStart && $from.index(depth) > 0)
          from -= $from.node(depth).child($from.index(depth) - 1).nodeSize
        if (toEnd && $to.index(depth) + 1 < $to.node(depth).childCount)
          to += $to.node(depth).child($to.index(depth) + 1).nodeSize
        return {from, to}
      }
    }
  }
}

function keyEvent(keyCode, key) {
  let event = document.createEvent("Event")
  event.initEvent("keydown", true, true)
  event.keyCode = keyCode
  event.key = event.code = key
  return event
}

function readDOMChange(view, mapping, oldState, range) {
  let parse = parseBetween(view, oldState, range)

  let doc = oldState.doc, compare = doc.slice(parse.from, parse.to)
  let change = findDiff(compare.content, parse.doc.content, parse.from, oldState.selection.from)

  if (!change) {
    if (parse.sel) {
      let sel = resolveSelection(view, view.state.doc, mapping, parse.sel)
      if (sel && !sel.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(sel))
    }
    return
  }

  let $from = parse.doc.resolveNoCache(change.start - parse.from)
  let $to = parse.doc.resolveNoCache(change.endB - parse.from)
  let nextSel
  // If this looks like the effect of pressing Enter, just dispatch an
  // Enter key instead.
  if (!$from.sameParent($to) && $from.pos < parse.doc.content.size &&
      (nextSel = Selection.findFrom(parse.doc.resolve($from.pos + 1), 1, true)) &&
      nextSel.head == $to.pos &&
      view.someProp("handleKeyDown", f => f(view, keyEvent(13, "Enter"))))
    return
  // Same for backspace
  if (oldState.selection.anchor > change.start &&
      looksLikeJoin(doc, change.start, change.endA, $from, $to) &&
      view.someProp("handleKeyDown", f => f(view, keyEvent(8, "Backspace"))))
    return

  let from = mapping.map(change.start), to = mapping.map(change.endA, -1)

  let tr, storedMarks, markChange, $from1
  if ($from.sameParent($to) && $from.parent.inlineContent) {
    if ($from.pos == $to.pos) { // Deletion
      tr = view.state.tr.delete(from, to)
      let $start = doc.resolve(change.start)
      if ($start.parentOffset < $start.parent.content.size) storedMarks = $start.marks(true)
    } else if ( // Adding or removing a mark
      change.endA == change.endB && ($from1 = doc.resolve(change.start)) &&
      (markChange = isMarkChange($from.parent.content.cut($from.parentOffset, $to.parentOffset),
                                 $from1.parent.content.cut($from1.parentOffset, change.endA - $from1.start())))
    ) {
      tr = view.state.tr
      if (markChange.type == "add") tr.addMark(from, to, markChange.mark)
      else tr.removeMark(from, to, markChange.mark)
    } else if ($from.parent.child($from.index()).isText && $from.index() == $to.index() - ($to.textOffset ? 0 : 1)) {
      // Both positions in the same text node -- simply insert text
      let text = $from.parent.textBetween($from.parentOffset, $to.parentOffset)
      if (view.someProp("handleTextInput", f => f(view, from, to, text))) return
      tr = view.state.tr.insertText(text, from, to)
    }
  }

  if (!tr)
    tr = view.state.tr.replace(from, to, parse.doc.slice(change.start - parse.from, change.endB - parse.from))
  if (parse.sel) {
    let sel = resolveSelection(view, tr.doc, mapping, parse.sel)
    if (sel) tr.setSelection(sel)
  }
  if (storedMarks) tr.ensureMarks(storedMarks)
  view.dispatch(tr.scrollIntoView())
}

function resolveSelection(view, doc, mapping, parsedSel) {
  if (Math.max(parsedSel.anchor, parsedSel.head) > doc.content.size) return null
  return selectionBetween(view, doc.resolve(mapping.map(parsedSel.anchor)),
                          doc.resolve(mapping.map(parsedSel.head)))
}

// : (Fragment, Fragment) → ?{mark: Mark, type: string}
// Given two same-length, non-empty fragments of inline content,
// determine whether the first could be created from the second by
// removing or adding a single mark type.
function isMarkChange(cur, prev) {
  let curMarks = cur.firstChild.marks, prevMarks = prev.firstChild.marks
  let added = curMarks, removed = prevMarks, type, mark, update
  for (let i = 0; i < prevMarks.length; i++) added = prevMarks[i].removeFromSet(added)
  for (let i = 0; i < curMarks.length; i++) removed = curMarks[i].removeFromSet(removed)
  if (added.length == 1 && removed.length == 0) {
    mark = added[0]
    type = "add"
    update = node => node.mark(mark.addToSet(node.marks))
  } else if (added.length == 0 && removed.length == 1) {
    mark = removed[0]
    type = "remove"
    update = node => node.mark(mark.removeFromSet(node.marks))
  } else {
    return null
  }
  let updated = []
  for (let i = 0; i < prev.childCount; i++) updated.push(update(prev.child(i)))
  if (Fragment.from(updated).eq(cur)) return {mark, type}
}

function looksLikeJoin(old, start, end, $newStart, $newEnd) {
  if (!$newStart.parent.isTextblock ||
      // The content must have shrunk
      end - start <= $newEnd.pos - $newStart.pos ||
      // newEnd must point directly at or after the end of the block that newStart points into
      skipClosingAndOpening($newStart, true, false) < $newEnd.pos)
    return false

  let $start = old.resolve(start)
  // Start must be at the end of a block
  if ($start.parentOffset < $start.parent.content.size || !$start.parent.isTextblock)
    return false
  let $next = old.resolve(skipClosingAndOpening($start, true, true))
  // The next textblock must start before end and end near it
  if (!$next.parent.isTextblock || $next.pos > end ||
      skipClosingAndOpening($next, true, false) < end)
    return false

  // The fragments after the join point must match
  return $newStart.parent.content.cut($newStart.parentOffset).eq($next.parent.content)
}

function skipClosingAndOpening($pos, fromEnd, mayOpen) {
  let depth = $pos.depth, end = fromEnd ? $pos.end() : $pos.pos
  while (depth > 0 && (fromEnd || $pos.indexAfter(depth) == $pos.node(depth).childCount)) {
    depth--
    end++
    fromEnd = false
  }
  if (mayOpen) {
    let next = $pos.node(depth).maybeChild($pos.indexAfter(depth))
    while (next && !next.isLeaf) {
      next = next.firstChild
      end++
    }
  }
  return end
}

function findDiff(a, b, pos, preferedStart) {
  let start = a.findDiffStart(b, pos)
  if (start == null) return null
  let {a: endA, b: endB} = a.findDiffEnd(b, pos + a.size, pos + b.size)
  if (endA < start && a.size < b.size) {
    let move = preferedStart <= start && preferedStart >= endA ? start - preferedStart : 0
    start -= move
    endB = start + (endB - endA)
    endA = start
  } else if (endB < start) {
    let move = preferedStart <= start && preferedStart >= endB ? start - preferedStart : 0
    start -= move
    endA = start + (endA - endB)
    endB = start
  }
  return {start, endA, endB}
}
