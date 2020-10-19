describe('Plugin', () => {
  it('shows a deprecation warning when registering via the "app" component', () => {
    cy.visit('/plugin/deprecated', {
      onBeforeLoad (window) {
        cy.spy(window.console, 'warn').as('consoleWarn')
      },
    })

    cy.window().then(window => {
      const inertiaRoot = window.testing.vue.$children[0]
      const page = inertiaRoot.$children[0]

      expect(page.$page).to.deep.equal(page.$inertia.page)
      expect(page.$inertia).to.deep.equal(window.testing.Inertia)

      cy
        .get('@consoleWarn')
        .should('be.calledWith',
          'Registering the Inertia Vue plugin via the "app" component has been deprecated. Use the new "plugin" named export instead.\n\n' +
          'import { plugin } from \'@inertiajs/inertia-vue\'\n\n' +
          'Vue.use(plugin)',
        )
    })
  })

  describe('$page helper', () => {
    it('has the helper injected into the Vue component', () => {
      cy.visit('/')

      cy.window().then(window => {
        const inertiaRoot = window.testing.vue.$children[0]
        const page = inertiaRoot.$children[0]

        expect(page.$page).to.deep.equal(page.$inertia.page)
      })
    })

    it('misses the helper when not registered', () => {
      cy.visit('/plugin/without')

      cy.window().then(window => {
        const inertiaRoot = window.testing.vue.$children[0]
        const page = inertiaRoot.$children[0]

        expect(page.$page).to.be.undefined
      })
    })
  })

  describe('$inertia helper', () => {
    it('has the helper injected into the Vue component', () => {
      cy.visit('/')

      cy.window().then(window => {
        const inertiaRoot = window.testing.vue.$children[0]
        const page = inertiaRoot.$children[0]

        expect(page.$inertia).to.deep.equal(window.testing.Inertia)
      })
    })

    it('misses the helper when not registered', () => {
      cy.visit('/plugin/without')

      cy.window().then(window => {
        const inertiaRoot = window.testing.vue.$children[0]
        const page = inertiaRoot.$children[0]

        expect(page.$inertia).to.be.undefined
      })
    })
  })

  describe('InertiaLink', () => {
    it('visits a different page', () => {
      cy.visit('/links')

      // Fail the assertion when a hard visit / location visit is made.
      // Inertia's SPA-visit should not trigger this.
      cy.on('load', () => expect(true).to.equal(false))

      cy.get('.basic').click()
      cy.url().should('eq', Cypress.config().baseUrl + '/links-target/get')

      cy
        .get('body > div:first-child > span:nth-child(1)')
        .should('have.text', 'This is one of the links target page')
    })

    describe('Methods', () => {
      it('can use the GET method', () => {
        cy.visit('/links')

        // Fail the assertion when a hard visit / location visit is made.
        // Inertia's SPA-visit should not trigger this.
        cy.on('load', () => expect(true).to.equal(false))

        cy.get('.get').click()
        cy.url().should('eq', Cypress.config().baseUrl + '/links-target/get')

        cy
          .get('body > div:first-child > span:nth-child(2)')
          .should('have.text', 'Method: get')
      })

      it('can use the POST method', () => {
        cy.visit('/links')

        // Fail the assertion when a hard visit / location visit is made.
        // Inertia's SPA-visit should not trigger this.
        cy.on('load', () => expect(true).to.equal(false))

        cy.get('.post').click()
        cy.url().should('eq', Cypress.config().baseUrl + '/links-target/post')

        cy
          .get('body > div:first-child > span:nth-child(2)')
          .should('have.text', 'Method: post')
      })

      it('can use the PUT method', () => {
        cy.visit('/links')

        // Fail the assertion when a hard visit / location visit is made.
        // Inertia's SPA-visit should not trigger this.
        cy.on('load', () => expect(true).to.equal(false))

        cy.get('.put').click()
        cy.url().should('eq', Cypress.config().baseUrl + '/links-target/put')

        cy
          .get('body > div:first-child > span:nth-child(2)')
          .should('have.text', 'Method: put')
      })

      it('can use the PATCH method', () => {
        cy.visit('/links')

        // Fail the assertion when a hard visit / location visit is made.
        // Inertia's SPA-visit should not trigger this.
        cy.on('load', () => expect(true).to.equal(false))

        cy.get('.patch').click()
        cy.url().should('eq', Cypress.config().baseUrl + '/links-target/patch')

        cy
          .get('body > div:first-child > span:nth-child(2)')
          .should('have.text', 'Method: patch')
      })

      it('can use the DELETE method', () => {
        cy.visit('/links')

        // Fail the assertion when a hard visit / location visit is made.
        // Inertia's SPA-visit should not trigger this.
        cy.on('load', () => expect(true).to.equal(false))

        cy.get('.delete').click()
        cy.url().should('eq', Cypress.config().baseUrl + '/links-target/delete')

        cy
          .get('body > div:first-child > span:nth-child(2)')
          .should('have.text', 'Method: delete')
      })
    })
  })

})