using UnrealBuildTool;

public class EngineRuntime : ModuleRules
{
    public EngineRuntime(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "Engine" });
    }
}
