#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "AbilitySystemInterface.h"
#include "GameplayTagAssetInterface.h"

class UAvatarHealthComponent;
class UAvatarExtensionComponent;

DECLARE_MULTICAST_DELEGATE_ThreeParams(FAvatarMovementModeChangedSignature, class ACharacter*, EMovementMode, uint8);

UCLASS(Config = Game)
class GAME_API AAvatarCharacter : public ACharacter, public IAbilitySystemInterface, public IGameplayTagAssetInterface
{
    GENERATED_BODY()

public:
    AAvatarCharacter(const FObjectInitializer& ObjectInitializer);

    virtual UAbilitySystemComponent* GetAbilitySystemComponent() const override;
    virtual void GetOwnedGameplayTags(FGameplayTagContainer& TagContainer) const override;

protected:
    virtual void BeginPlay() override;
    virtual void NotifyControllerChanged() override;
    virtual void OnMovementModeChanged(EMovementMode PrevMovementMode, uint8 PreviousCustomMode = 0) override;

private:
    void HandleAbilitySystemReady();
    void HandleAbilitySystemReset();

    UPROPERTY(VisibleAnywhere, Category = "Avatar")
    TObjectPtr<UAvatarExtensionComponent> ExtensionComponent;

    UPROPERTY(VisibleAnywhere, Category = "Avatar")
    TObjectPtr<UAvatarHealthComponent> HealthComponent;

    FAvatarMovementModeChangedSignature MovementModeChangedDelegate;
};
