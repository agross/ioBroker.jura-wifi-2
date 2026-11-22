"""Refresh JURA product settings from the app's machine profiles."""

import argparse
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.request import urlopen
import xml.etree.ElementTree as ET
from zipfile import ZipFile


FALLBACK_REVISION = "3b711222b1a9d2fae248c5495db840be5d9b8c5a"
FALLBACK_URL = f"https://codeload.github.com/makefu/jura-connect/zip/{FALLBACK_REVISION}"
APK_DIRECTORY = "assets/documents/xml/"
FALLBACK_DIRECTORY = f"jura-connect-{FALLBACK_REVISION}/jura_connect/data/xml/"
CATALOGS = Path(__file__).resolve().parents[1] / "lib" / "catalogs"
PROFILE_PATH = re.compile(r"(EF\d+[A-Z0-9_]*)/(\d+(?:\.\d+)*)\.xml", re.I)

# Match both the setting and its wire position. F17 grinder fineness, for
# example, cannot use the F2 high nibble in the adapter's 16-byte payload.
BREW_FIELDS = {
    ("GRINDER_FREENESS", "F2_H"): "grindLevel",
    ("COFFEE_STRENGTH", "F3"): "strength",
    ("WATER_AMOUNT", "F4"): "water",
    ("MILK_AMOUNT", "F5"): "milkAmount",
    ("MILK_AMOUNT", "F6"): "milk",
    ("MILK_FOAM_AMOUNT", "F6"): "milk",
    ("TEMPERATURE", "F7"): "defaultTemperature",
    ("STROKE", "F8"): "strokes",
    ("BYPASS", "F10"): "bypass",
    ("MILK_BREAK", "F11"): "milkPause",
    ("MILK_FOAM_TEMP", "F14_1"): "milkFoamTemperature",
    ("MILK_TEMP", "F14_2"): "milkTemperature",
}
PRODUCT_KINDS = {"C": "COFFEE", "CM": "COFFEE_MILK", "M": "MILK", "T": "WATER"}
MAINTENANCE_NAMES = {
    "Cleaning": "Cleaning",
    "FilterChange": "Filter change",
    "Decalc": "Descaling",
    "CoffeeRinse": "Coffee rinse",
    "CappuClean": "Milk system cleaning",
    "CappuRinse": "Milk system rinse",
}


def profiles(archive, directory):
    newest = {}
    for path in archive.namelist():
        if not path.startswith(directory):
            continue
        match = PROFILE_PATH.fullmatch(path.removeprefix(directory))
        if not match:
            continue
        model, version = match.groups()
        model = model.upper()
        if model == "EF0000":  # Generic template.
            continue
        version = tuple(map(int, version.split(".")))
        if model not in newest or version > newest[model][0]:
            newest[model] = (version, path)
    return {model: archive.read(path) for model, (_, path) in newest.items()}


def app_profiles(path):
    with ZipFile(path) as archive:
        entries = set(archive.namelist())
        if "AndroidManifest.xml" in entries:
            return profiles(archive, APK_DIRECTORY)

        # An XAPK wraps the base APK and its configuration splits.
        for name in ("ch.toptronic.joe.apk", "base.apk"):
            if name in entries:
                with ZipFile(BytesIO(archive.read(name))) as base:
                    return profiles(base, APK_DIRECTORY)

    raise ValueError("Expected a J.O.E. APK or an XAPK containing its base APK")


def numeric_range(setting):
    if setting.get("Step") is not None:
        return {
            key: int(setting.attrib[attr])
            for key, attr in (
                ("default", "Value"), ("min", "Min"), ("max", "Max"), ("step", "Step"),
            )
        }

    shift = 4 if setting.get("Argument") == "F2_H" else 0
    values = sorted({int(item.attrib["Value"], 16) >> shift for item in setting})
    default = int(setting.attrib["Default"], 16) >> shift
    step = values[1] - values[0] if len(values) > 1 else 1
    if default not in values or values != list(range(values[0], values[-1] + 1, step)):
        raise ValueError(f"{setting.tag} has an invalid or nonuniform range")
    return {"default": default, "min": values[0], "max": values[-1], "step": step}


def product_settings(product):
    settings = {}
    additional = {}
    for setting in product:
        tag = setting.tag.split("}")[-1]
        argument = setting.get("Argument")
        field = BREW_FIELDS.get((tag, argument))
        if field == "defaultTemperature":
            settings[field] = ("LOW", "NORMAL", "HIGH")[int(setting.attrib["Default"], 16)]
        elif field:
            settings[field] = numeric_range(setting)
        elif argument:
            metadata = {"argument": argument}
            if "Step" in setting.attrib:
                metadata["range"] = numeric_range(setting)
            else:
                metadata["default"] = setting.attrib["Default"]
                metadata["options"] = {
                    item.attrib["Value"]: item.attrib["Name"] for item in setting
                }
            additional[tag] = metadata
        elif tag == "PRESELECTION":
            choices = {
                name: True for name, value in setting.attrib.items()
                if value == "true" and name != "double"
            }
            double_code = int(setting.get("double", "0"), 16)
            if double_code:
                choices["double"] = double_code
            if choices:
                settings["preselections"] = choices
    if additional:
        settings["additionalSettings"] = additional
    return settings


def new_catalog(model, root, products):
    maintenance = {}
    for bank in root.findall("./{*}STATISTIC/{*}MAINTENANCEPAGE/{*}BANK"):
        maintenance[bank.get("Command")] = [
            MAINTENANCE_NAMES.get(item.attrib["Type"], item.attrib["Type"])
            for item in bank.findall("{*}TEXTITEM")
        ]
    return {
        "modelId": model,
        "products": [
            {"code": code, "name": product.attrib["Name"].strip(), "kind": PRODUCT_KINDS[product.attrib["P_Kind"]]}
            for code, product in products.items()
            if product.get("Active") != "false"
            and product.get("DoubleProduct") != "true"
            and any(setting.get("Argument") for setting in product)
        ],
        "alertBits": {
            alert.attrib["Bit"]: alert.attrib["Name"] for alert in root.findall("./{*}ALERTS/{*}ALERT")
        },
        "brewStateNames": {
            f'0x{int(state.attrib["Value"], 16):02X}': state.attrib["Name"]
            for state in root.findall("./{*}PROGRESS_STATE_INTAKE/*")
            if "Value" in state.attrib and "Name" in state.attrib
        },
        "dispensingStates": ["0x3C", "0x41"],
        "maintenanceStatusFields": maintenance.get("@TG:C0", []),
        "maintenanceCounterFields": maintenance.get("@TG:43", []),
    }


def catalog_update(model, xml):
    root = ET.fromstring(xml)
    products = {
        int(product.attrib["Code"], 16): product
        for product in root.findall("./{*}PRODUCTS/{*}PRODUCT")
    }
    path = CATALOGS / f"{model}.json"
    original = path.read_text(encoding="utf-8") if path.exists() else ""
    catalog = json.loads(original) if original else new_catalog(model, root, products)
    capabilities = root.find("./{*}MACHINEMANIFEST/{*}CAPABILITIES")
    intake_f18 = capabilities is not None and capabilities.get("IntakeF18") == "true"
    combinations = [
        [name.lower() for name, value in row.attrib.items() if value == "true"]
        for row in root.findall("./{*}MULTIPLE_PRESELECTS/{*}COMBINATION")
    ]
    for key, value in (
        ("intakeF18", intake_f18),
        ("preselectionCombinations", [row for row in combinations if len(row) > 1]),
    ):
        if value:
            catalog[key] = value
        else:
            catalog.pop(key, None)
    # Existing names are part of ioBroker state IDs. Keep the product list
    # and counter overrides that the adapter already exposes.
    imported_fields = {*BREW_FIELDS.values(), "preselections", "additionalSettings"}
    for product in catalog["products"]:
        source = products.get(product["code"])
        if source is not None:
            settings = product_settings(source)
            preselections = settings.get("preselections", {})
            if not intake_f18 and "double" in preselections and preselections["double"] not in products:
                del preselections["double"]
                if not preselections:
                    del settings["preselections"]
            for field in imported_fields - settings.keys():
                product.pop(field, None)
            product.update(settings)
    updated = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
    if updated.rstrip("\n") != original.rstrip("\n"):
        return path, updated
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, help="J.O.E. APK or XAPK to prefer over the pinned fallback")
    args = parser.parse_args()
    apk = app_profiles(args.apk) if args.apk else {}
    with urlopen(FALLBACK_URL, timeout=30) as response:
        with ZipFile(BytesIO(response.read())) as archive:
            fallback = profiles(archive, FALLBACK_DIRECTORY)
    selected = fallback | apk
    updates = [
        update for model, xml in sorted(selected.items())
        if (update := catalog_update(model, xml)) is not None
    ]
    for path, contents in updates:
        path.write_text(contents, encoding="utf-8")
    print(
        f"{len(updates)} catalogs updated "
        f"({len(apk)} from APK, {len(fallback.keys() - apk)} from fallback)"
    )


if __name__ == "__main__":
    main()
