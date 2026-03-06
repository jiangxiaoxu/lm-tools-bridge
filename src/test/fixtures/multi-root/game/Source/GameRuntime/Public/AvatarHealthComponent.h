#pragma once

#include "Components/GameFrameworkComponent.h"
#include "GameplayEffectTypes.h"
#include "AvatarHealthComponent.generated.h"

class UAbilitySystemComponent;
class UAvatarHealthComponent;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FAvatarDeathEvent, AActor*, OwningActor);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_FourParams(FAvatarHealthChangedEvent, UAvatarHealthComponent*, HealthComponent, float, OldValue, float, NewValue, AActor*, Instigator);

UENUM(BlueprintType)
enum class EAvatarDeathState : uint8
{
    Alive = 0,
    DeathStarted,
    DeathFinished,
};

UCLASS()
class GAME_API UAvatarHealthComponent : public UGameFrameworkComponent
{
    GENERATED_BODY()

public:
    UAvatarHealthComponent(const FObjectInitializer& ObjectInitializer);

    UFUNCTION(BlueprintCallable, Category = "Avatar|Health")
    void InitializeWithAbilitySystem(UAbilitySystemComponent* InASC);

    UFUNCTION(BlueprintCallable, Category = "Avatar|Health")
    void UninitializeFromAbilitySystem();

    UFUNCTION(BlueprintCallable, Category = "Avatar|Health")
    float GetHealthNormalized() const;

    virtual void StartDeath();
    virtual void FinishDeath();

    UPROPERTY(BlueprintAssignable)
    FAvatarHealthChangedEvent OnHealthChanged;

    UPROPERTY(BlueprintAssignable)
    FAvatarDeathEvent OnDeathStarted;

    UPROPERTY(BlueprintAssignable)
    FAvatarDeathEvent OnDeathFinished;

protected:
    virtual void OnUnregister() override;

private:
    UPROPERTY()
    TObjectPtr<UAbilitySystemComponent> AbilitySystemComponent;

    UPROPERTY()
    EAvatarDeathState DeathState = EAvatarDeathState::Alive;

    float CurrentHealth = 100.0f;
    float MaxHealth = 100.0f;
};
