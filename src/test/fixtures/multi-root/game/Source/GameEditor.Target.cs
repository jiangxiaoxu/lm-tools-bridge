using UnrealBuildTool;
using System.Collections.Generic;

public class GameEditorTarget : TargetRules
{
    public GameEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        ExtraModuleNames.AddRange(new string[] { "GameEditor", "GameRuntime" });
    }
}
