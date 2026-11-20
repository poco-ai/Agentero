"""Browse the proposed help pages. Only the local Markdown reference is read."""

from difflib import get_close_matches
from pathlib import Path
import re
import sys


def main(args):
    document = Path(__file__).with_name("cli-reference.md").read_text(encoding="utf-8")
    sections = re.findall(
        r"^## `(agentero(?: [\w-]+)*) --help`\n\n```text\n(.*?)\n```$",
        document,
        flags=re.MULTILINE | re.DOTALL,
    )
    pages = dict(sections)
    options = args[:args.index("--")] if "--" in args else args
    explicit_help = any(arg in ("-h", "--help") for arg in options)
    if args[:1] == ["help"] and args[1:] not in (["-h"], ["--help"]):
        args = args[1:]
    command = "agentero"
    words = iter(args)
    for word in words:
        if explicit_help and word in ("--vault", "--color"):
            next(words, None)
            continue
        if explicit_help and word.startswith("-"):
            continue
        children = {key[len(command) + 1:].split()[0]
                    for key in pages if key.startswith(command + " ")}
        if word in children:
            command += " " + word
        elif explicit_help and not children:
            break
        else:
            closest = get_close_matches(word, sorted(children), n=1)
            hint = f"试试 {command} {closest[0]} --help" if closest else f"查看 {command} --help"
            print(f"找不到帮助页 {command} {word}。{hint}。", file=sys.stderr)
            return 2
    print(pages[command])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
