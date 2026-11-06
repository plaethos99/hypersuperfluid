"""Static checks of an Odoo module, run before installing it.

They catch the mistakes that most often break installs or upgrades: a manifest that does not parse or lists a
missing file, Python files never imported (so their models silently do not exist), new models without access
rules, XML ids referenced before or without being defined, views using syntax the Odoo version removed
(`<tree>` in 18, `attrs` and `states` since 17), and SQL built by string formatting.
"""

from __future__ import annotations

import ast
import csv
import io
import re
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

from erp_agent.customize.checks import Findings

_ACCESS_HEADER = ["id", "name", "model_id:id", "group_id:id", "perm_read", "perm_write", "perm_create", "perm_unlink"]
_DATA_DIRS = ("security", "views", "data", "report", "reports", "wizard", "wizards")
_PACKAGES_SKIPPED = frozenset({"tests", "migrations", "upgrades", "static"})
_REF_ATTRIBUTES = ("ref", "parent", "action", "inherit_id", "groups")
_EVAL_REF = re.compile(r"""\bref\(\s*['"]([\w.]+)['"]\s*\)""")
_BASE_FIELDS = frozenset({"id", "display_name", "create_uid", "create_date", "write_uid", "write_date"})
_MAIL_MIXINS = frozenset({"mail.thread", "mail.activity.mixin"})
_MAIL_FIELDS = frozenset(
    {
        "message_follower_ids",
        "activity_ids",
        "message_ids",
        "activity_state",
        "activity_user_id",
        "message_attachment_count",
    }
)


@dataclass
class ModelDef:
    name: str
    path: str
    fields: set[str]
    extends: bool
    abstract: bool
    mixins: frozenset[str] = frozenset()


@dataclass
class ModuleReport:
    findings: Findings = field(default_factory=Findings)
    new_models: dict[str, ModelDef] = field(default_factory=dict)
    files_checked: int = 0


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _check_manifest(module_dir: Path, module: str, odoo_version: str, found: Findings) -> dict[str, object] | None:
    path = module_dir / "__manifest__.py"
    if not path.is_file():
        found.errors.append(f"{module}: __manifest__.py is missing")
        return None
    try:
        manifest = ast.literal_eval(path.read_text(encoding="utf-8"))
    except (SyntaxError, ValueError) as exc:
        found.errors.append(f"{module}/__manifest__.py must be a plain dictionary literal: {exc}")
        return None
    if not isinstance(manifest, dict):
        found.errors.append(f"{module}/__manifest__.py must be a dictionary")
        return None
    if not isinstance(manifest.get("name"), str):
        found.errors.append(f"{module}/__manifest__.py needs a name")
    version = str(manifest.get("version", ""))
    if not version.startswith(f"{odoo_version}."):
        found.warnings.append(
            f"{module}/__manifest__.py: version {version!r} should look like {odoo_version}.1.0.0; raise it on every "
            "change that needs an upgrade"
        )
    if "license" not in manifest:
        found.warnings.append(f"{module}/__manifest__.py: no license; Odoo assumes LGPL-3")
    depends = manifest.get("depends", [])
    if not isinstance(depends, list) or not all(isinstance(d, str) for d in depends):
        found.errors.append(f"{module}/__manifest__.py: depends must be a list of module names")
    elif not depends:
        found.warnings.append(f"{module}/__manifest__.py: depends is empty; add at least base")
    for key in ("data", "demo"):
        files = manifest.get(key, [])
        if not isinstance(files, list):
            found.errors.append(f"{module}/__manifest__.py: {key} must be a list")
            continue
        for name in files:
            if not (module_dir / str(name)).is_file():
                found.errors.append(f"{module}/__manifest__.py lists {name}, which does not exist")
    if manifest.get("installable") is False:
        found.warnings.append(f"{module} is marked installable: False")
    return manifest


def _imports(init: Path) -> set[str]:
    try:
        tree = ast.parse(init.read_text(encoding="utf-8"))
    except SyntaxError:
        return set()
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 1:
            if node.module:
                names.add(node.module.split(".")[0])
            names.update(alias.name for alias in node.names)
    return names


def _check_imports(module_dir: Path, root: Path, found: Findings) -> None:
    for package in [module_dir, *[p for p in module_dir.iterdir() if p.is_dir()]]:
        if package.name in _PACKAGES_SKIPPED or package.name.startswith((".", "_")):
            continue
        modules = {p.stem for p in package.glob("*.py") if p.name != "__init__.py" and p.name != "__manifest__.py"}
        subpackages = {p.name for p in package.iterdir() if p.is_dir() and any(p.glob("*.py"))} - _PACKAGES_SKIPPED
        expected = modules | (subpackages if package == module_dir else set())
        if not expected:
            continue
        init = package / "__init__.py"
        if not init.is_file():
            found.errors.append(f"{_rel(package, root)}/__init__.py is missing, so its Python files are never loaded")
            continue
        missing = sorted(expected - _imports(init))
        for name in missing:
            found.errors.append(
                f"{_rel(init, root)} does not import {name}, so Odoo never loads it (its models and fields are missing)"
            )
    tests = module_dir / "tests"
    if tests.is_dir():
        test_files = {p.stem for p in tests.glob("test_*.py")}
        missing_tests = (
            sorted(test_files - _imports(tests / "__init__.py")) if (tests / "__init__.py").is_file() else []
        )
        for name in missing_tests:
            found.warnings.append(f"{_rel(tests, root)}/__init__.py does not import {name}; those tests never run")


def _string_value(node: ast.expr) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _class_models(tree: ast.Module, path: str) -> list[ModelDef]:
    found: list[ModelDef] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        attrs: dict[str, ast.expr] = {}
        fields: set[str] = set()
        for stmt in node.body:
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                name = stmt.targets[0].id
                attrs[name] = stmt.value
                value = stmt.value
                if (
                    isinstance(value, ast.Call)
                    and isinstance(value.func, ast.Attribute)
                    and isinstance(value.func.value, ast.Name)
                    and value.func.value.id == "fields"
                ):
                    fields.add(name)
        model = _string_value(attrs["_name"]) if "_name" in attrs else None
        inherit = attrs.get("_inherit")
        inherited = (
            {_string_value(e) for e in inherit.elts} if isinstance(inherit, ast.List | ast.Tuple) else
            {_string_value(inherit)} if inherit is not None else set()
        )  # fmt: skip
        bases = {b.attr if isinstance(b, ast.Attribute) else getattr(b, "id", "") for b in node.bases}
        if model is None and not inherited:
            continue
        found.append(
            ModelDef(
                name=model or next(iter(sorted(n for n in inherited if n))),
                path=path,
                fields=fields,
                extends=model is None or model in inherited,
                abstract="AbstractModel" in bases,
                mixins=frozenset(n for n in inherited if n),
            )
        )
    return found


def _check_python(path: Path, root: Path, report: ModuleReport) -> None:
    rel = _rel(path, root)
    found = report.findings
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=rel)
    except (SyntaxError, UnicodeDecodeError) as exc:
        found.errors.append(f"{rel}: {exc}")
        return
    in_tests = "/tests/" in f"/{rel}"
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            if attr == "execute" and node.args:
                query = node.args[0]
                formatted = (
                    isinstance(query, ast.JoinedStr)
                    or (isinstance(query, ast.BinOp) and isinstance(query.op, ast.Mod | ast.Add))
                    or (
                        isinstance(query, ast.Call)
                        and isinstance(query.func, ast.Attribute)
                        and query.func.attr == "format"
                    )
                )
                if formatted:
                    found.errors.append(
                        f"{rel}:{node.lineno}: SQL built by string formatting; pass values as parameters "
                        "(cr.execute(query, params)) or use odoo.tools.SQL"
                    )
            elif attr == "commit" and not in_tests:
                found.errors.append(f"{rel}:{node.lineno}: never commit inside module code; Odoo commits the request")
        elif (
            isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("print", "eval", "exec")
        ):
            message = "use _logger instead of print" if node.func.id == "print" else f"{node.func.id}() runs any code"
            found.warnings.append(f"{rel}:{node.lineno}: {message}")
        elif isinstance(node, ast.Import | ast.ImportFrom):
            names = [node.module or ""] if isinstance(node, ast.ImportFrom) else [a.name for a in node.names]
            if any(n.split(".")[0] in ("subprocess", "pickle", "marshal") for n in names):
                found.warnings.append(f"{rel}:{node.lineno}: imports {', '.join(names)}; justify it in review")
    if not in_tests:
        for model in _class_models(tree, rel):
            if not model.extends:
                report.new_models[model.name] = model


def _xml_ids(module: str, module_dir: Path, data_files: list[str], found: Findings) -> None:
    defined: dict[str, int] = {}
    for order, name in enumerate(data_files):
        path = module_dir / name
        if path.suffix == ".csv" and path.is_file():
            with path.open(encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    if row.get("id"):
                        defined.setdefault(row["id"], order)
        if path.suffix != ".xml" or not path.is_file():
            continue
        try:
            tree = etree.parse(str(path), parser=etree.XMLParser(resolve_entities=False, no_network=True))
        except etree.XMLSyntaxError:
            continue
        for element in tree.iter(etree.Element):  # not comments: their .get() ignores the default
            xml_id = element.get("id")
            if xml_id and element.tag in ("record", "template", "menuitem", "report", "act_window"):
                defined.setdefault(xml_id.removeprefix(f"{module}."), order)
    for order, name in enumerate(data_files):
        path = module_dir / name
        if path.suffix != ".xml" or not path.is_file():
            continue
        try:
            tree = etree.parse(str(path), parser=etree.XMLParser(resolve_entities=False, no_network=True))
        except etree.XMLSyntaxError:
            continue
        for element in tree.iter(etree.Element):  # not comments: their .get() ignores the default
            refs: list[str] = []
            for attribute in _REF_ATTRIBUTES:
                value = element.get(attribute)
                if not value:
                    continue
                if attribute == "groups":
                    refs += [g.strip().lstrip("!") for g in value.split(",") if g.strip()]
                elif attribute == "ref" or element.tag == "menuitem" or attribute == "inherit_id":
                    refs.append(value)
            refs += _EVAL_REF.findall(element.get("eval", ""))
            for ref in refs:
                owner, _, local = ref.rpartition(".")
                if owner and owner != module:
                    continue
                if local not in defined:
                    found.errors.append(f"{module}/{name}: refers to {ref}, which no data file of {module} defines")
                elif defined[local] > order:
                    found.errors.append(
                        f"{module}/{name}: refers to {ref} before it is loaded; reorder data in the manifest"
                    )


def _check_xml(path: Path, root: Path, major: int, report: ModuleReport) -> None:
    rel = _rel(path, root)
    found = report.findings
    try:
        tree = etree.parse(str(path), parser=etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError as exc:
        found.errors.append(f"{rel}: XML is not well-formed: {exc}")
        return
    for element in tree.iter():
        if not isinstance(element.tag, str):
            continue
        line = element.sourceline
        if major >= 18 and element.tag == "tree":
            found.errors.append(f"{rel}:{line}: <tree> views are <list> since Odoo 18")
        if major >= 17 and (element.get("attrs") is not None or element.get("states") is not None):
            found.errors.append(
                f"{rel}:{line}: attrs and states were removed in Odoo 17; use invisible/readonly/required expressions"
            )
        if (
            major >= 18
            and element.tag == "field"
            and element.get("name") == "view_mode"
            and "tree" in (element.text or "")
        ):
            found.errors.append(f"{rel}:{line}: view_mode uses 'tree'; Odoo 18 calls it 'list'")
    for record in tree.iter("record"):
        if record.get("model") != "ir.ui.view":
            continue
        model_field = record.find("field[@name='model']")
        arch = record.find("field[@name='arch']")
        if model_field is None or arch is None or record.find("field[@name='inherit_id']") is not None:
            continue
        model = report.new_models.get((model_field.text or "").strip())
        # Fields of other mixins are unknown here; only models built from fields this module declares are checked.
        if model is None or model.abstract or model.mixins - _MAIL_MIXINS:
            continue
        known = model.fields | _BASE_FIELDS | (_MAIL_FIELDS if model.mixins else frozenset())
        for view in arch:
            if isinstance(view.tag, str):
                _check_view_fields(view, known, model.name, rel, found)


def _check_view_fields(
    element: etree._Element, known: frozenset[str] | set[str], model: str, rel: str, found: Findings
) -> None:
    for child in element:
        if not isinstance(child.tag, str):
            continue
        if child.tag == "field":
            if child.get("name") not in known:
                found.errors.append(f"{rel}:{child.sourceline}: field {child.get('name')} is not defined on {model}")
            continue  # an embedded list or form inside a field shows another model's fields
        _check_view_fields(child, known, model, rel, found)


def _check_access(module: str, module_dir: Path, root: Path, data: list[str], report: ModuleReport) -> None:
    found = report.findings
    covered: set[str] = set()
    for name in data:
        path = module_dir / name
        if not (path.suffix == ".csv" and path.stem == "ir.model.access" and path.is_file()):
            continue
        rows = list(csv.reader(io.StringIO(path.read_text(encoding="utf-8"))))
        if not rows or [h.strip() for h in rows[0]] != _ACCESS_HEADER:
            found.errors.append(f"{_rel(path, root)}: header must be {','.join(_ACCESS_HEADER)}")
            continue
        for row in rows[1:]:
            if len(row) != len(_ACCESS_HEADER):
                if any(cell.strip() for cell in row):
                    found.errors.append(f"{_rel(path, root)}: row {row} needs {len(_ACCESS_HEADER)} columns")
                continue
            covered.add(row[2].strip().rpartition(".")[2])
    for model in report.new_models.values():
        if model.abstract:
            continue
        if f"model_{model.name.replace('.', '_')}" not in covered:
            found.errors.append(
                f"{model.path}: new model {model.name} has no line in security/ir.model.access.csv; without one only "
                "the superuser can use it"
            )


def _file_list(manifest: dict[str, object] | None, key: str) -> list[str]:
    value = manifest.get(key) if manifest else None
    return [str(n) for n in value] if isinstance(value, list) else []


def check_module(root: Path, module: str, odoo_version: str) -> ModuleReport:
    """Run every static check on one module of a workspace.

    @param root: Workspace root.
    @param module: Module directory name.
    @param odoo_version: Workspace Odoo version, such as `18.0`.
    @returns: Errors (fix before installing), warnings (review) and the new models found.
    """
    report = ModuleReport()
    found = report.findings
    module_dir = root / module
    if not module_dir.is_dir():
        found.errors.append(f"module {module} does not exist")
        return report
    manifest = _check_manifest(module_dir, module, odoo_version, found)
    _check_imports(module_dir, root, found)
    for path in sorted(module_dir.rglob("*.py")):
        if "__pycache__" not in path.parts and path.name != "__manifest__.py":
            _check_python(path, root, report)
            report.files_checked += 1
    major = int(odoo_version.split(".")[0])
    for path in sorted(module_dir.rglob("*.xml")):
        _check_xml(path, root, major, report)
        report.files_checked += 1
    data = _file_list(manifest, "data")
    if manifest is not None:
        listed = set(data) | set(_file_list(manifest, "demo"))
        for folder in _DATA_DIRS:
            for path in sorted((module_dir / folder).glob("*")):
                rel = _rel(path, module_dir)
                if path.suffix in (".xml", ".csv") and rel not in listed:
                    found.warnings.append(f"{module}/{rel} is not listed in the manifest, so Odoo never loads it")
        _xml_ids(module, module_dir, data, found)
        _check_access(module, module_dir, root, data, report)
    return report
