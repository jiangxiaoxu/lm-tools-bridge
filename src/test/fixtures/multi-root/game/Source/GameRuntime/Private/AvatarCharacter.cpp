#include "AvatarCharacter.h"

#include "AvatarExtensionComponent.h"
#include "AvatarHealthComponent.h"
#include "Components/CapsuleComponent.h"

AAvatarCharacter::AAvatarCharacter(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    UCapsuleComponent* CapsuleComponent = GetCapsuleComponent();
    check(CapsuleComponent);
    CapsuleComponent->InitCapsuleSize(42.0f, 92.0f);

    ExtensionComponent = CreateDefaultSubobject<UAvatarExtensionComponent>(TEXT("ExtensionComponent"));
    HealthComponent = CreateDefaultSubobject<UAvatarHealthComponent>(TEXT("HealthComponent"));
}

UAbilitySystemComponent* AAvatarCharacter::GetAbilitySystemComponent() const
{
    return nullptr;
}

void AAvatarCharacter::GetOwnedGameplayTags(FGameplayTagContainer& TagContainer) const
{
    TagContainer.Reset();
}

void AAvatarCharacter::BeginPlay()
{
    Super::BeginPlay();
    HandleAbilitySystemReady();
}

void AAvatarCharacter::NotifyControllerChanged()
{
    Super::NotifyControllerChanged();
}

void AAvatarCharacter::OnMovementModeChanged(EMovementMode PrevMovementMode, uint8 PreviousCustomMode)
{
    Super::OnMovementModeChanged(PrevMovementMode, PreviousCustomMode);
    MovementModeChangedDelegate.Broadcast(this, PrevMovementMode, PreviousCustomMode);
}

void AAvatarCharacter::HandleAbilitySystemReady()
{
}

void AAvatarCharacter::HandleAbilitySystemReset()
{
}
