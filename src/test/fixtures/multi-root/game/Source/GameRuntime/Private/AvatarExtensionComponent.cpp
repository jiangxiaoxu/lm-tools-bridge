#include "AvatarExtensionComponent.h"

#include "AbilitySystemComponent.h"

UAvatarExtensionComponent::UAvatarExtensionComponent(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
}

bool UAvatarExtensionComponent::CanChangeInitState(UGameFrameworkComponentManager* Manager, FGameplayTag CurrentState, FGameplayTag DesiredState) const
{
    return true;
}

void UAvatarExtensionComponent::HandleChangeInitState(UGameFrameworkComponentManager* Manager, FGameplayTag CurrentState, FGameplayTag DesiredState)
{
}

void UAvatarExtensionComponent::OnActorInitStateChanged(const FActorInitStateChangedParams& Params)
{
}

void UAvatarExtensionComponent::CheckDefaultInitialization()
{
}

void UAvatarExtensionComponent::InitializeAbilitySystem(UAbilitySystemComponent* InASC, AActor* InOwnerActor)
{
    AbilitySystemComponent = InASC;
}

void UAvatarExtensionComponent::UninitializeAbilitySystem()
{
    AbilitySystemComponent = nullptr;
}

void UAvatarExtensionComponent::HandleControllerChanged()
{
}

void UAvatarExtensionComponent::OnRegister()
{
    Super::OnRegister();
}
