using UnrealBuildTool;
using System.Collections.Generic;

public class EngineTarget : TargetRules
{
    public EngineTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Game;
        DefaultBuildSettings = BuildSettingsVersion.V5;
        ExtraModuleNames.AddRange(new string[] { "EngineRuntime" });
    }
}
