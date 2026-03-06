#pragma once

#include "CoreMinimal.h"
#include "GameplayTagContainer.h"
#include "Components/ActorComponent.h"
#include "VisibilityByTagsComponent.generated.h"

class UAbilitySystemComponent;

UCLASS(ClassGroup=(Custom), meta=(BlueprintSpawnableComponent))
class GAME_API UVisibilityByTagsComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UVisibilityByTagsComponent();

    UFUNCTION(BlueprintCallable)
    void InitializeFromAbilitySystem(UAbilitySystemComponent* InASC);

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    void HandleWatchedTagsChanged();

    UPROPERTY()
    TObjectPtr<UAbilitySystemComponent> OwnerASC;

    UPROPERTY(EditAnywhere, Category = "Visibility")
    TArray<FGameplayTag> RequireTags;

    UPROPERTY(EditAnywhere, Category = "Visibility")
    TArray<FGameplayTag> IgnoreTags;

    UPROPERTY(EditAnywhere, Category = "Visibility")
    bool bHideActor = true;
};
