"""team_from_path: an access rule that gives a document the role of its top folder.

`legal/contracts/a.pdf` is readable by the `legal` role. A document outside any
folder gets no opinion from this rule, so the next rule or the default decides.
Use it with `access: {rules: [team_from_path]}` in pipeline.yaml.
"""

from pandion.extend import DocumentInfo, access_rule


@access_rule("team_from_path")
def team_from_path(info: DocumentInfo) -> list[str] | None:
    team, slash, _ = info.path.replace("\\", "/").partition("/")
    return [team] if slash and team else None
