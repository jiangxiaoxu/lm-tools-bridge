#pragma once

#include "Components/GameFrameworkInitStateInterface.h"
#include "Components/PawnComponent.h"
#include "AvatarExtensionComponent.generated.h"

class UAbilitySystemComponent;
struct FActorInitStateChangedParams;
struct FGameplayTag;
class UGameFrameworkComponentManager;

UCLASS()
class GAME_API UAvatarExtensionComponent : public UPawnComponent, public IGameFrameworkInitStateInterface
{
    GENERATED_BODY()

public:
    UAvatarExtensionComponent(const FObjectInitializer& ObjectInitializer);

    static inline const FName NAME_ActorFeatureName = TEXT("AvatarExtension");

    virtual FName GetFeatureName() const override { return NAME_ActorFeatureName; }
    virtual bool CanChangeInitState(UGameFrameworkComponentManager* Manager, FGameplayTag CurrentState, FGameplayTag DesiredState) const override;
    virtual void HandleChangeInitState(UGameFrameworkComponentManager* Manager, FGameplayTag CurrentState, FGameplayTag DesiredState) override;
    virtual void OnActorInitStateChanged(const FActorInitStateChangedParams& Params) override;
    virtual void CheckDefaultInitialization() override;

    void InitializeAbilitySystem(UAbilitySystemComponent* InASC, AActor* InOwnerActor);
    void UninitializeAbilitySystem();
    void HandleControllerChanged();

protected:
    virtual void OnRegister() override;

private:
    UPROPERTY()
    TObjectPtr<UAbilitySystemComponent> AbilitySystemComponent;
};
