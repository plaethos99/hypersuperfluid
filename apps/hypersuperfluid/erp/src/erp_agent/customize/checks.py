"""Offline checks of sandboxed Python, domains and inheritance XML before anything reaches Odoo.

Odoo runs server-action code through `odoo.tools.safe_eval`, which refuses imports, names containing `__` and a
list of introspection attributes. Refusing those here gives the model a precise message at planning time instead
of a constraint error at apply time. Constructs that Odoo allows but a reviewer must look at (superuser mode,
deletions, raw SQL, commits) are reported as warnings.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Any

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

# odoo/tools/safe_eval.py `_UNSAFE_ATTRIBUTES` (Odoo 18).
_UNSAFE_NAMES = frozenset(
    {
        "f_builtins", "f_code", "f_globals", "f_locals", "f_generator", "func_code", "func_globals", "co_code",
        "_co_code_adaptive", "mro", "tb_frame", "gi_code", "gi_frame", "gi_yieldfrom", "cr_await", "cr_code",
        "cr_frame", "ag_await", "ag_code", "ag_frame",
    }
)  # fmt: skip
_REVIEW_CALLS = {
    "sudo": "runs as superuser and bypasses access rights",
    "unlink": "deletes records",
    "commit": "commits the transaction; a later error can no longer roll it back",
    "rollback": "rolls back the whole transaction",
    "execute": "runs raw SQL that skips the ORM, access rights and computed fields",
}
_DOMAIN_OPERATORS = frozenset({"&", "|", "!"})
_SPEC_TAGS = frozenset({"xpath", "field", "button", "div", "group", "page", "notebook", "sheet", "header", "label"})
_SUBVIEW_TAGS = frozenset({"list", "tree", "form", "kanban"})


@dataclass
class Findings:
    """Errors block a change set; warnings are shown to the person with the plan."""

    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def extend(self, other: Findings) -> None:
        """@param other: Findings to append."""
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)


def check_code(code: str, where: str) -> Findings:
    """Check sandboxed Python the way Odoo's `safe_eval` will, and flag constructs a reviewer must see.

    @param code: Server action or scheduled action code.
    @param where: Label for messages, such as `automation "Notify manager", action 1`.
    @returns: Errors for code Odoo would refuse, warnings for code that needs review.
    """
    found = Findings()
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        found.errors.append(f"{where}: Python syntax error on line {exc.lineno}: {exc.msg}")
        return found
    for node in ast.walk(tree):
        if isinstance(node, ast.Import | ast.ImportFrom):
            found.errors.append(f"{where}: imports are not allowed in Odoo server code (line {node.lineno})")
        elif isinstance(node, ast.Name | ast.Attribute):
            name = node.id if isinstance(node, ast.Name) else node.attr
            if "__" in name or name in _UNSAFE_NAMES:
                found.errors.append(f"{where}: Odoo refuses the name {name!r} (line {node.lineno})")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in _REVIEW_CALLS:
            found.warnings.append(
                f"{where}: line {node.lineno} calls {node.func.attr}(), which {_REVIEW_CALLS[node.func.attr]}"
            )
    return found


def check_expression(expression: str, where: str) -> Findings:
    """@param expression: A Python expression Odoo evaluates (computed update values).
    @param where: Label for messages.
    @returns: The same findings as `check_code`, plus an error when it is not a single expression."""
    try:
        ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        return Findings(errors=[f"{where}: not a Python expression: {exc.msg}"])
    return check_code(expression, where)


@dataclass(frozen=True)
class Domain:
    """A parsed Odoo domain: its source and the field paths its conditions name."""

    source: str
    terms: tuple[ast.expr, ...]
    field_paths: tuple[str, ...]


def parse_domain(source: str, where: str) -> Domain:
    """Parse an Odoo domain such as `[('state', '=', 'sale'), ('amount_total', '>', 10000)]`.

    Values may be expressions Odoo evaluates later (`uid`, `context_today()`); only the structure is checked.

    @param source: Domain text.
    @param where: Label for messages.
    @returns: The parsed domain.
    @raises ValueError: When the text is not a list of conditions and `&` / `|` / `!` operators.
    """
    try:
        node = ast.parse(source.strip(), mode="eval").body
    except SyntaxError as exc:
        raise ValueError(f"{where}: domain is not valid Python: {exc.msg}") from exc
    if not isinstance(node, ast.List):
        raise ValueError(f"{where}: a domain must be a list, such as [('state', '=', 'sale')]")
    paths: list[str] = []
    for term in node.elts:
        if isinstance(term, ast.Constant) and term.value in _DOMAIN_OPERATORS:
            continue
        if (
            isinstance(term, ast.Tuple | ast.List)
            and len(term.elts) == 3
            and isinstance(term.elts[0], ast.Constant)
            and isinstance(term.elts[0].value, str)
            and isinstance(term.elts[1], ast.Constant)
            and isinstance(term.elts[1].value, str)
        ):
            paths.append(term.elts[0].value)
            continue
        raise ValueError(f"{where}: each domain term must be ('field', 'operator', value) or '&', '|', '!'")
    found = check_code(source, where)
    if found.errors:
        raise ValueError("; ".join(found.errors))
    return Domain(source=source, terms=tuple(node.elts), field_paths=tuple(paths))


def join_domains(*domains: Domain | str | None) -> str | None:
    """AND several domains by concatenating their terms (valid for well-formed prefix-notation domains).

    @param domains: Parsed domains, domain text built by this module, or None.
    @returns: The combined domain text, or None when every part is empty.
    """
    terms: list[ast.expr] = []
    for domain in domains:
        if domain is None:
            continue
        parsed = domain if isinstance(domain, Domain) else parse_domain(domain, "domain")
        terms.extend(parsed.terms)
    return ast.unparse(ast.List(elts=terms, ctx=ast.Load())) if terms else None


@dataclass(frozen=True)
class ViewArch:
    """A checked inheritance arch and the field names it adds at the top level of the parent view."""

    fields: tuple[str, ...]


def check_arch(arch: str, where: str) -> ViewArch:
    """Check inheritance XML: well-formed, made of xpath (or element) specs that each say where they apply.

    @param arch: `<xpath expr="..." position="...">` elements, or several of them inside `<data>`.
    @param where: Label for messages.
    @returns: Names of the `<field>` elements it adds outside embedded list and form views.
    @raises ValueError: When the XML is malformed or is a full view rather than an extension.
    """
    try:
        root = ElementTree.fromstring(arch)
    except (ElementTree.ParseError, DefusedXmlException) as exc:
        raise ValueError(f"{where}: arch is not well-formed XML: {exc}") from exc
    specs = list(root) if root.tag == "data" else [root]
    if not specs:
        raise ValueError(f"{where}: <data> holds no inheritance specs")
    for spec in specs:
        if spec.tag not in _SPEC_TAGS:
            raise ValueError(
                f"{where}: <{spec.tag}> is not an inheritance spec; use <xpath expr=... position=...> to place content"
            )
        if spec.tag == "xpath" and not spec.get("expr"):
            raise ValueError(f"{where}: <xpath> needs an expr attribute")
        position = spec.get("position", "inside")
        if position not in ("inside", "after", "before", "replace", "attributes", "move"):
            raise ValueError(f"{where}: unknown position {position!r}")
    names: list[str] = []

    def collect(element: Any, nested: bool) -> None:
        for child in element:
            inside = nested or child.tag in _SUBVIEW_TAGS
            if child.tag == "field" and not inside and child.get("name"):
                names.append(str(child.get("name")))
            collect(child, inside)

    for spec in specs:
        if spec.get("position", "inside") != "attributes":
            collect(spec, nested=False)
    return ViewArch(fields=tuple(names))
