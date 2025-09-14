/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { PaneComposite, PaneCompositeDescriptor, PaneCompositeRegistry, Extensions as PaneCompositeExtensions } from '../../../../browser/panecomposite.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';

/**
 * A host that can render any pane composite in an arbitrary container.
 * This breaks the tight coupling between composites and their fixed locations.
 */
export class EmbeddedCompositeHost extends Disposable {

	private composites = new Map<string, { composite: PaneComposite; container: HTMLElement; disposables: DisposableStore }>();
	private currentCompositeId: string | undefined;
	private creatingComposites = new Set<string>();

	constructor(
		private readonly container: HTMLElement,
		private readonly location: ViewContainerLocation,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		// Ensure container has proper styling
		this.container.classList.add('embedded-composite-host');
	}

	async openComposite(compositeId: string): Promise<PaneComposite | undefined> {
		// Prevent concurrent creation of the same composite
		if (this.creatingComposites.has(compositeId)) {
			console.log(`[EmbeddedCompositeHost] Composite ${compositeId} is already being created`);
			return undefined;
		}

		// If same composite, just show it again
		if (this.currentCompositeId === compositeId) {
			const existing = this.composites.get(compositeId);
			if (existing && !existing.disposables.isDisposed) {
				this.showComposite(compositeId);
				return existing.composite;
			}
			// If it was disposed, remove it from the map
			if (existing) {
				this.composites.delete(compositeId);
			}
		}

		// Hide current composite (but don't dispose)
		if (this.currentCompositeId) {
			this.hideComposite(this.currentCompositeId);
		}

		// Get the correct registry based on location
		let registryId: string;
		switch (this.location) {
			case ViewContainerLocation.Panel:
				registryId = PaneCompositeExtensions.Panels;
				break;
			case ViewContainerLocation.AuxiliaryBar:
				registryId = PaneCompositeExtensions.Auxiliary;
				break;
			case ViewContainerLocation.Sidebar:
			default:
				registryId = PaneCompositeExtensions.Viewlets;
				break;
		}

		// Check if composite already exists
		const existing = this.composites.get(compositeId);
		if (existing && !existing.disposables.isDisposed) {
			this.showComposite(compositeId);
			return existing.composite;
		}
		// If it was disposed, remove it from the map
		if (existing) {
			this.composites.delete(compositeId);
		}

		// Get composite descriptor
		const registry = Registry.as<PaneCompositeRegistry>(registryId);
		const descriptor = registry.getPaneComposite(compositeId);

		if (!descriptor) {
			console.error(`[EmbeddedCompositeHost] Composite not found: ${compositeId}`);
			return undefined;
		}

		// Mark as creating
		this.creatingComposites.add(compositeId);

		let disposables: DisposableStore | undefined;
		let compositeContainer: HTMLElement | undefined;

		try {
			// Create the composite
			const composite = await this.createComposite(descriptor);

			if (!composite) {
				return undefined;
			}

			// Create a disposable store for this composite
			disposables = new DisposableStore();

			// Register the composite itself for disposal
			disposables.add(composite);

			// Create container for composite
			compositeContainer = document.createElement('div');
			compositeContainer.className = 'composite embedded-composite';
			compositeContainer.id = compositeId;
			compositeContainer.style.display = 'none'; // Start hidden

			try {
				// Let composite create its UI
				composite.create(compositeContainer);
				composite.updateStyles();
			} catch (createError) {
				// If create fails, dispose everything we've created
				console.error(`[EmbeddedCompositeHost] Failed to create UI for composite ${compositeId}:`, createError);
				disposables.dispose();
				compositeContainer.remove();
				throw createError;
			}

			// Add to our container
			this.container.appendChild(compositeContainer);

			// Store the composite with its disposables
			this.composites.set(compositeId, { composite, container: compositeContainer, disposables });

			// Show it
			this.showComposite(compositeId);

			console.log(`[EmbeddedCompositeHost] Composite created and opened: ${compositeId}`);
			return composite;

		} catch (error) {
			console.error(`[EmbeddedCompositeHost] Failed to create composite ${compositeId}:`, error);

			// Clean up any resources that were created
			if (disposables) {
				disposables.dispose();
			}
			if (compositeContainer && compositeContainer.parentElement) {
				compositeContainer.remove();
			}

			return undefined;
		} finally {
			// Always remove from creating set
			this.creatingComposites.delete(compositeId);
		}
	}

	private async createComposite(descriptor: PaneCompositeDescriptor): Promise<PaneComposite | undefined> {
		// Create a scoped instantiation service for the composite
		const serviceCollection = new ServiceCollection();
		// Add any scoped services needed by the composite

		const compositeInstantiationService = this.instantiationService.createChild(serviceCollection);

		// Don't dispose the instantiation service - let the composite keep it
		// We'll dispose it when we dispose the entire host

		// Instantiate the composite using the descriptor's instantiate method
		const composite = descriptor.instantiate(compositeInstantiationService);

		// PaneComposite doesn't have an init method - it initializes through constructor
		// The composite is ready to use after instantiation

		return composite;
	}

	private showComposite(compositeId: string): void {
		const entry = this.composites.get(compositeId);
		if (!entry) {
			return;
		}

		// Hide current composite
		if (this.currentCompositeId && this.currentCompositeId !== compositeId) {
			this.hideComposite(this.currentCompositeId);
		}

		// Show the new composite
		entry.container.style.display = 'block';
		entry.container.style.height = '100%';
		entry.composite.setVisible(true);

		// Layout
		const bounds = this.container.getBoundingClientRect();
		entry.composite.layout(new Dimension(bounds.width, bounds.height));

		this.currentCompositeId = compositeId;
	}

	private hideComposite(compositeId: string): void {
		const entry = this.composites.get(compositeId);
		if (!entry) {
			return;
		}

		// Just hide it, don't dispose
		entry.composite.setVisible(false);
		entry.container.style.display = 'none';
	}

	disposeComposite(compositeId: string): void {
		const entry = this.composites.get(compositeId);
		if (!entry) {
			return;
		}

		// Hide first
		if (this.currentCompositeId === compositeId) {
			this.hideComposite(compositeId);
			this.currentCompositeId = undefined;
		}

		// Dispose the composite and its resources
		entry.composite.setVisible(false);
		entry.disposables.dispose();
		entry.container.remove();

		// Remove from our map
		this.composites.delete(compositeId);
	}

	layout(dimension: Dimension): void {
		if (this.currentCompositeId) {
			const entry = this.composites.get(this.currentCompositeId);
			if (entry) {
				entry.composite.layout(dimension);
			}
		}
	}

	override dispose(): void {
		// Dispose all composites
		for (const [_, entry] of this.composites) {
			entry.composite.setVisible(false);
			entry.disposables.dispose(); // This will dispose the composite
			entry.container.remove();
		}
		this.composites.clear();

		super.dispose();
	}
}
