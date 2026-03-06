#include "VisibilityByTagsComponent.h"

#include "AbilitySystemComponent.h"

UVisibilityByTagsComponent::UVisibilityByTagsComponent()
{
}

void UVisibilityByTagsComponent::BeginPlay()
{
    Super::BeginPlay();
    HandleWatchedTagsChanged();
}

void UVisibilityByTagsComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    Super::EndPlay(EndPlayReason);
    OwnerASC = nullptr;
}

void UVisibilityByTagsComponent::InitializeFromAbilitySystem(UAbilitySystemComponent* InASC)
{
    OwnerASC = InASC;
    HandleWatchedTagsChanged();
}

void UVisibilityByTagsComponent::HandleWatchedTagsChanged()
{
    if (AActor* OwnerActor = GetOwner())
    {
        OwnerActor->SetActorHiddenInGame(false);
    }
}
