using UnrealBuildTool;

public class GameEditor : ModuleRules
{
    public GameEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "GameRuntime" });
        PrivateDependencyModuleNames.AddRange(new string[] { "Slate", "UnrealEd" });
    }
}
