#include "AvatarHealthComponent.h"

#include "AbilitySystemComponent.h"

UAvatarHealthComponent::UAvatarHealthComponent(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    PrimaryComponentTick.bCanEverTick = false;
}

void UAvatarHealthComponent::InitializeWithAbilitySystem(UAbilitySystemComponent* InASC)
{
    AbilitySystemComponent = InASC;
    CurrentHealth = MaxHealth;
    OnHealthChanged.Broadcast(this, CurrentHealth, CurrentHealth, GetOwner());
}

void UAvatarHealthComponent::UninitializeFromAbilitySystem()
{
    AbilitySystemComponent = nullptr;
}

float UAvatarHealthComponent::GetHealthNormalized() const
{
    return MaxHealth > 0.0f ? (CurrentHealth / MaxHealth) : 0.0f;
}

void UAvatarHealthComponent::StartDeath()
{
    if (DeathState != EAvatarDeathState::Alive)
    {
        return;
    }

    DeathState = EAvatarDeathState::DeathStarted;
    OnDeathStarted.Broadcast(GetOwner());
}

void UAvatarHealthComponent::FinishDeath()
{
    if (DeathState != EAvatarDeathState::DeathStarted)
    {
        return;
    }

    DeathState = EAvatarDeathState::DeathFinished;
    OnDeathFinished.Broadcast(GetOwner());
}

void UAvatarHealthComponent::OnUnregister()
{
    UninitializeFromAbilitySystem();
    Super::OnUnregister();
}
